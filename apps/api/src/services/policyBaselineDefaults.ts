/**
 * Canonical "Breeze Defaults" — the single source of truth for how an UNASSIGNED
 * device behaves (no config policy anywhere in its hierarchy). Surfaced read-only
 * in the UI as the bottom of the assignment hierarchy (#1725).
 *
 * Semantics = runtime behavior, not form-fill values. Most feature types are
 * "Not enforced" (their resolvers return null/[] with no policy). Only
 * remote_access and pam carry applied defaults — and those are imported BY the
 * enforcement paths (remoteAccessPolicy.ts / pamSettings.ts) so there is exactly
 * one definition each.
 */
import { CONFIG_FEATURE_TYPES, type ConfigFeatureType } from './configurationPolicy';
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

// label + behavior + applied/inlineSettings for every feature type. Order
// follows CONFIG_FEATURE_TYPES. "Not enforced" entries describe the real-world
// effect of having no policy.
const NOT_ENFORCED: Record<Exclude<ConfigFeatureType, 'remote_access' | 'pam'>, { label: string; behavior: string }> = {
  patch:             { label: 'Patches',            behavior: 'Not enforced — no patch deployments are created from policy.' },
  alert_rule:        { label: 'Alerts',             behavior: 'Not enforced — no policy alert rules fire.' },
  backup:            { label: 'Backup',             behavior: 'Not enforced — no backups are scheduled.' },
  security:          { label: 'Security',           behavior: 'Not enforced — no security posture is applied.' },
  monitoring:        { label: 'Monitoring',         behavior: 'Not enforced — no service/process monitoring runs.' },
  maintenance:       { label: 'Maintenance',        behavior: 'Not enforced — no maintenance windows apply.' },
  compliance:        { label: 'Compliance',         behavior: 'Not enforced — no compliance checks run.' },
  automation:        { label: 'Automations',        behavior: 'Not enforced — no automations execute.' },
  event_log:         { label: 'Event Logs',         behavior: 'Not enforced — no event-log collection tuning applies.' },
  software_policy:   { label: 'Software Policy',     behavior: 'Not enforced — no allow/block software rules apply.' },
  sensitive_data:    { label: 'Data Discovery',     behavior: 'Not enforced — no sensitive-data scans run.' },
  peripheral_control:{ label: 'Peripheral Control', behavior: 'Not enforced — peripherals are unrestricted.' },
  warranty:          { label: 'Warranty',           behavior: 'Not enforced — no warranty alerts apply.' },
  helper:            { label: 'Breeze Assist',      behavior: 'Not enforced — Breeze Assist uses its built-in defaults.' },
  onedrive_helper:   { label: 'OneDrive Helper',    behavior: 'Not enforced — no OneDrive helper config applies.' },
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
    const meta = NOT_ENFORCED[ft];
    return { featureType: ft, label: meta.label, applied: false, inlineSettings: null, behavior: meta.behavior };
  });
}
