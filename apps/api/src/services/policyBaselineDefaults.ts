/**
 * Canonical "Breeze Defaults" — the single source of truth for how an UNASSIGNED
 * device behaves (no config policy anywhere in its hierarchy). Surfaced read-only
 * in the UI as the bottom of the assignment hierarchy (#1725).
 *
 * Semantics = runtime behavior, not form-fill values. Most feature types are
 * "Not enforced" (their resolvers return null/[] with no policy). Three carry
 * applied defaults: remote_access and pam are imported BY their enforcement paths
 * (remoteAccessPolicy.ts / pamSettings.ts); event_log is the inverse — the agent
 * collects unconditionally, so this module owns the canonical default value and
 * the enforcement path (helpers.ts EVENT_LOG_DEFAULTS) imports it FROM here. Each
 * has exactly one definition.
 */
// Import the feature-type list from the leaf module, NOT from configurationPolicy
// — importing from the service would create a runtime cycle and pull the heavy
// service into pamSettings/helpers test suites (#1725 PR review).
import { CONFIG_FEATURE_TYPES, type ConfigFeatureType } from './configFeatureTypes';
import type { RemoteAccessSettings } from './remoteAccessPolicy';

export interface BaselineEntry {
  featureType: ConfigFeatureType;
  label: string;
  /** Does anything actually apply to an unassigned device? */
  applied: boolean;
  /** Resolved settings when applied; null when "Not enforced". */
  inlineSettings: Record<string, unknown> | null;
  /** Human-readable behavior label for the UI. */
  behavior: string;
}

// Hosted multi-tenant SaaS defaults the silent-exfil direction (remote host
// clipboard → operator viewer) OFF, so an MSP operator can't passively harvest
// whatever a customer copies during a session. Operator→host paste stays on for
// usability. Self-hosted (single-tenant, IS_HOSTED!='true') preserves the
// historical bidirectional default so an upgrade doesn't silently change
// behavior for an admin running their own instance. There's no dedicated
// clipboard-direction UI yet (one is being added separately), but both
// defaults are overridable via an explicit `remote_access` policy. Finding #7.
const isHosted = process.env.IS_HOSTED === 'true';

export function getRemoteAccessBaseline(): RemoteAccessSettings {
  return {
    webrtcDesktop: true,
    vncRelay: true,
    remoteTools: true,
    clipboardHostToViewer: !isHosted,
    clipboardViewerToHost: true,
    enableProxy: true,
    defaultAllowedPorts: [],
    autoEnableProxy: false,
    maxConcurrentTunnels: 5,
    idleTimeoutMinutes: 5,
    maxSessionDurationHours: 8,
  };
}

export function getPamBaseline(): { uacInterceptionEnabled: boolean } {
  return { uacInterceptionEnabled: false };
}

// Event-log collection is ON for every device by default — the agent collects
// unconditionally and the heartbeat resolver returns these same values when no
// policy is assigned (helpers.ts EVENT_LOG_DEFAULTS is this baseline, so there is
// exactly one definition). It is therefore an *applied* baseline (like
// remote_access/pam), NOT "Not enforced". A config policy only tunes these knobs.
// `type` (not `interface`) so it carries an implicit index signature and is
// assignable to BaselineEntry.inlineSettings (Record<string, unknown>) without a
// cast — same reason getPamBaseline's inline object-literal type needs none.
export type EventLogBaselineSettings = {
  retentionDays: number;
  maxEventsPerCycle: number;
  collectCategories: ('security' | 'hardware' | 'application' | 'system')[];
  minimumLevel: 'info' | 'warning' | 'error' | 'critical';
  collectionIntervalMinutes: number;
  rateLimitPerHour: number;
};

export function getEventLogBaseline(): EventLogBaselineSettings {
  return {
    retentionDays: 30,
    maxEventsPerCycle: 100,
    collectCategories: ['security', 'hardware', 'application', 'system'],
    minimumLevel: 'info',
    collectionIntervalMinutes: 5,
    rateLimitPerHour: 12000,
  };
}

// label + behavior + applied/inlineSettings for every feature type. Order
// follows CONFIG_FEATURE_TYPES. "Not enforced" entries describe the real-world
// effect of having no policy.
const NOT_ENFORCED: Record<Exclude<ConfigFeatureType, 'remote_access' | 'pam' | 'event_log'>, { label: string; behavior: string }> = {
  patch:             { label: 'Patches',            behavior: 'Not enforced — no patches are installed without a policy. (Available updates are still scanned and reported.)' },
  alert_rule:        { label: 'Alerts',             behavior: 'Not enforced — no policy alert rules fire.' },
  backup:            { label: 'Backup',             behavior: 'Not enforced — no backups are scheduled.' },
  security:          { label: 'Security',           behavior: 'Not enforced — no security posture is applied. (Defender, BitLocker & firewall status is still reported every 5 min.)' },
  monitoring:        { label: 'Monitoring',         behavior: 'Not enforced — no service/process monitoring runs.' },
  maintenance:       { label: 'Maintenance',        behavior: 'Not enforced — no maintenance windows apply.' },
  compliance:        { label: 'Compliance',         behavior: 'Not enforced — no compliance checks run.' },
  automation:        { label: 'Automations',        behavior: 'Not enforced — no automations execute.' },
  software_policy:   { label: 'Software Policy',     behavior: 'Not enforced — no allow/block software rules apply.' },
  sensitive_data:    { label: 'Data Discovery',     behavior: 'Not enforced — no sensitive-data scans run.' },
  peripheral_control:{ label: 'Peripheral Control', behavior: 'Not enforced — peripherals are unrestricted.' },
  warranty:          { label: 'Warranty',           behavior: 'Not enforced — no warranty alerts apply. (Warranty/coverage data is still collected with inventory.)' },
  helper:            { label: 'Breeze Assist',      behavior: 'Not enforced — Breeze Assist is disabled by default; enable it via a policy.' },
  onedrive_helper:   { label: 'OneDrive Helper',    behavior: 'Not enforced — no OneDrive helper config applies.' },
  vulnerability:     { label: 'Vulnerability Scanning', behavior: 'Not enforced — vulnerability correlation does not run for these devices.' },
};

export function getPolicyBaselineDefaults(): BaselineEntry[] {
  return CONFIG_FEATURE_TYPES.map((ft): BaselineEntry => {
    if (ft === 'remote_access') {
      return {
        featureType: ft,
        label: 'Remote Access',
        applied: true,
        inlineSettings: getRemoteAccessBaseline() as unknown as Record<string, unknown>,
        behavior: 'Remote Desktop, VNC, and Remote Tools are ON by default; session limits apply.',
      };
    }
    if (ft === 'pam') {
      return {
        featureType: ft,
        label: 'Privileged Access',
        applied: true,
        inlineSettings: getPamBaseline(),
        behavior: 'UAC elevation capture is OFF by default (opt-in via a policy).',
      };
    }
    if (ft === 'event_log') {
      return {
        featureType: ft,
        label: 'Event Logs',
        applied: true,
        inlineSettings: getEventLogBaseline(),
        behavior: 'Collected from every device by default — Security, Hardware, Application & System channels, every 5 min, 30-day retention. A policy only tunes these knobs.',
      };
    }
    const meta = NOT_ENFORCED[ft];
    return { featureType: ft, label: meta.label, applied: false, inlineSettings: null, behavior: meta.behavior };
  });
}
