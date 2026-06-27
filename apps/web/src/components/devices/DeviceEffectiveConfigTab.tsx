import { useCallback, useEffect, useState } from 'react';
import {
  Bell,
  Boxes,
  ClipboardCheck,
  Cloud,
  FileSearch,
  HardDrive,
  Layers,
  LifeBuoy,
  PackageCheck,
  RefreshCw,
  ScrollText,
  Shield,
  ShieldCheck,
  Activity,
  Usb,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import { friendlyFetchError } from '../../lib/utils';
import { fetchWithAuth } from '../../stores/auth';

// ── Types ────────────────────────────────────────────────────────────

type FeatureType =
  | 'patch'
  | 'alert_rule'
  | 'backup'
  | 'security'
  | 'monitoring'
  | 'maintenance'
  | 'compliance'
  | 'automation'
  | 'warranty'
  | 'helper'
  | 'event_log'
  | 'software_policy'
  | 'sensitive_data'
  | 'peripheral_control'
  | 'onedrive_helper';

type AssignmentLevel = 'partner' | 'organization' | 'site' | 'device_group' | 'device' | 'default';

type ResolvedFeature = {
  featureType: FeatureType;
  featurePolicyId: string | null;
  inlineSettings: Record<string, unknown> | null;
  sourceLevel: AssignmentLevel;
  sourceTargetId: string;
  sourcePolicyId: string;
  sourcePolicyName: string;
  sourcePriority: number;
};

type InheritanceEntry = {
  level: AssignmentLevel;
  targetId: string;
  policyId: string;
  policyName: string;
  priority: number;
  featureTypes: FeatureType[];
};

type EffectiveConfiguration = {
  deviceId: string;
  features: Record<string, ResolvedFeature>;
  inheritanceChain: InheritanceEntry[];
};

// ── Constants ────────────────────────────────────────────────────────

// Single source of truth for which config-policy feature types this tab renders.
// It is exhaustive over FeatureType (tsc fails if a union member lacks an entry),
// and ALL_FEATURE_TYPES below is derived from its keys, so a type can never be
// silently dropped from the grid — the original bug, where a resolved `warranty`
// feature rendered no card because it was absent from a hand-maintained list.
//
// remote_access and pam are deliberately absent from FeatureType (and so from
// this map): they are the two baselines that actively *apply* a value to an
// unassigned device (`applied: true` in policyBaselineDefaults.ts — remote_access
// defaults ON, pam is present but uacInterceptionEnabled:false). For them a
// 'default' source still means something is in effect, so the "Not enforced"
// labeling below would mislabel them. Every type present here is a "not enforced
// when unassigned" baseline, so that labeling is safe.
//
// NOTE: parity with the canonical CONFIG_FEATURE_TYPES
// (apps/api/src/services/configFeatureTypes.ts) minus those two is maintained by
// hand — no test enforces it. A new canonical feature type must be added here too
// or it won't render on this tab.
const FEATURE_META: Record<FeatureType, { label: string; Icon: LucideIcon }> = {
  patch:              { label: 'Patch Management',    Icon: PackageCheck },
  alert_rule:         { label: 'Alert Rules',         Icon: Bell },
  automation:         { label: 'Automation',          Icon: Zap },
  maintenance:        { label: 'Maintenance Windows', Icon: Wrench },
  compliance:         { label: 'Compliance',          Icon: ClipboardCheck },
  security:           { label: 'Security',            Icon: Shield },
  backup:             { label: 'Backup',              Icon: HardDrive },
  monitoring:         { label: 'Monitoring',          Icon: Activity },
  warranty:           { label: 'Warranty',            Icon: ShieldCheck },
  software_policy:    { label: 'Software Policy',     Icon: Boxes },
  sensitive_data:     { label: 'Data Discovery',      Icon: FileSearch },
  peripheral_control: { label: 'Peripheral Control',  Icon: Usb },
  event_log:          { label: 'Event Logs',          Icon: ScrollText },
  helper:             { label: 'Breeze Assist',       Icon: LifeBuoy },
  onedrive_helper:    { label: 'OneDrive Helper',     Icon: Cloud },
};

// Display order = FEATURE_META insertion order. Derived (not hand-listed) so the
// grid stays in lockstep with FEATURE_META and can't silently omit a type.
const ALL_FEATURE_TYPES = Object.keys(FEATURE_META) as FeatureType[];

const LEVEL_LABELS: Record<AssignmentLevel, string> = {
  partner: 'Partner',
  organization: 'Organization',
  site: 'Site',
  device_group: 'Device Group',
  device: 'Device',
  default: 'Breeze Defaults',
};

// ── Helpers ──────────────────────────────────────────────────────────

function summarizeSettings(settings: Record<string, unknown> | null): string[] {
  if (!settings || Object.keys(settings).length === 0) return [];
  const items: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (value === null || value === undefined) continue;
    // Format key from camelCase/snake_case to readable
    const label = key
      .replace(/_/g, ' ')
      .replace(/([A-Z])/g, ' $1')
      .replace(/^\s/, '')
      .toLowerCase();
    if (typeof value === 'boolean') {
      items.push(`${label}: ${value ? 'yes' : 'no'}`);
    } else if (typeof value === 'string' || typeof value === 'number') {
      items.push(`${label}: ${value}`);
    } else if (Array.isArray(value)) {
      items.push(`${label}: ${value.length} item${value.length !== 1 ? 's' : ''}`);
    }
    if (items.length >= 4) break; // limit to 4 summary lines
  }
  return items;
}

// ── Component ────────────────────────────────────────────────────────

type DeviceEffectiveConfigTabProps = {
  deviceId: string;
};

export default function DeviceEffectiveConfigTab({ deviceId }: DeviceEffectiveConfigTabProps) {
  const [data, setData] = useState<EffectiveConfiguration | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchEffectiveConfig = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/configuration-policies/effective/${deviceId}`);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      setData(await response.json());
    } catch (err) {
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchEffectiveConfig();
  }, [fetchEffectiveConfig]);

  // ── Loading state ──────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading effective configuration...</p>
        </div>
      </div>
    );
  }

  // ── Error state ────────────────────────────────────────────────────

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchEffectiveConfig}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  // ── Empty state ────────────────────────────────────────────────────

  const hasRealFeatures = data
    ? Object.values(data.features).some((f) => f.sourceLevel !== 'default')
    : false;
  if (!data || !hasRealFeatures) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center shadow-sm">
        <Layers className="mx-auto h-10 w-10 text-muted-foreground/50" />
        <h3 className="mt-4 font-semibold">No Configuration Policies</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          No configuration policies are currently assigned to this device.
          Assign policies through the Configuration Policies page.
        </p>
        <a
          href="/configuration-policies"
          className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Go to Config Policies
        </a>
        <a
          href="/configuration-policies/defaults"
          className="mt-2 inline-block text-sm font-medium text-primary hover:underline"
        >
          View Breeze Defaults
        </a>
      </div>
    );
  }

  const { features, inheritanceChain } = data;
  // The synthetic "Breeze Defaults" layer (level 'default') is excluded from the
  // assigned-policy count AND the inheritance-chain table below — it is not a real
  // assigned policy and has no policy page to link to. Its feature types instead
  // collapse into the "Not enforced — using Breeze Defaults" strip, and the
  // dedicated /configuration-policies/defaults page covers them in full.
  const assignedChain = inheritanceChain.filter((e) => e.level !== 'default');
  const configuredTypes = ALL_FEATURE_TYPES.filter((ft) => features[ft]);
  // Split enforced (a real assigned policy wins) from baseline fall-through.
  // Every type in ALL_FEATURE_TYPES is "not enforced when unassigned", so a
  // 'default' source unambiguously means baseline here (see the constant's note).
  const enforcedTypes = configuredTypes.filter((ft) => features[ft]!.sourceLevel !== 'default');
  const baselineTypes = configuredTypes.filter((ft) => features[ft]!.sourceLevel === 'default');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Effective Configuration</h3>
          <p className="text-sm text-muted-foreground">
            Resolved configuration from {assignedChain.length} assigned{' '}
            {assignedChain.length === 1 ? 'policy' : 'policies'} ·{' '}
            {enforcedTypes.length} enforced feature{enforcedTypes.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={fetchEffectiveConfig}
          className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {/* Enforced feature cards — only features a real assigned policy wins. */}
      {enforcedTypes.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {enforcedTypes.map((ft) => {
            const feature = features[ft]!;
            const { label, Icon } = FEATURE_META[ft];
            const settings = summarizeSettings(feature.inlineSettings);

            return (
              <div key={ft} className="rounded-lg border bg-card p-5 shadow-sm">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="font-semibold">{label}</h4>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      From: <span className="font-medium text-foreground">{feature.sourcePolicyName}</span>
                      {' '}
                      <span className="inline-flex items-center rounded-full border bg-muted/50 px-1.5 py-0.5 text-xs text-muted-foreground">
                        {LEVEL_LABELS[feature.sourceLevel]}
                      </span>
                    </p>
                  </div>
                </div>

                {/* Settings summary */}
                {settings.length > 0 && (
                  <div className="mt-3 rounded-md border bg-muted/30 px-3 py-2">
                    <ul className="space-y-0.5 text-xs text-muted-foreground">
                      {settings.map((s) => (
                        <li key={s} className="capitalize">{s}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Feature policy reference */}
                {feature.featurePolicyId && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Linked policy:{' '}
                    <span className="font-mono text-xs">{feature.featurePolicyId.slice(0, 8)}...</span>
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Not-enforced baseline features — collapsed into one compact strip so the
          page highlights what's actually applied instead of a wall of grey cards. */}
      {baselineTypes.length > 0 && (
        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-muted-foreground">Not enforced</h4>
            <span className="text-xs text-muted-foreground">— using Breeze Defaults</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {baselineTypes.map((ft) => {
              const { label, Icon } = FEATURE_META[ft];
              return (
                <span
                  key={ft}
                  className="inline-flex items-center gap-1.5 rounded-full border bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground"
                >
                  <Icon className="h-3.5 w-3.5 text-muted-foreground/70" />
                  {label}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Inheritance chain — real assigned policies only (the synthetic
          "Breeze Defaults" node is excluded; see assignedChain above). */}
      {assignedChain.length > 0 && (
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h4 className="font-semibold mb-3">Inheritance Chain</h4>
          <p className="text-xs text-muted-foreground mb-4">
            Policies are resolved using closest-wins priority. More specific assignments (device level)
            override broader ones (organization level).
          </p>
          <div className="overflow-hidden rounded-md border">
            <table className="min-w-full divide-y">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">Priority</th>
                  <th className="px-4 py-3">Level</th>
                  <th className="px-4 py-3">Policy</th>
                  <th className="px-4 py-3">Features</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {assignedChain.map((entry) => (
                  <tr key={`${entry.policyId}-${entry.level}-${entry.targetId}`} className="text-sm">
                    <td className="px-4 py-3 text-muted-foreground">{entry.priority}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center rounded-full border bg-muted/50 px-2.5 py-1 text-xs font-medium capitalize">
                        {LEVEL_LABELS[entry.level]}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <a
                        href={`/configuration-policies/${entry.policyId}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {entry.policyName}
                      </a>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {entry.featureTypes.map((ft) => (
                          <span
                            key={ft}
                            className="inline-flex items-center rounded-full border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground"
                          >
                            {FEATURE_META[ft]?.label ?? ft}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
