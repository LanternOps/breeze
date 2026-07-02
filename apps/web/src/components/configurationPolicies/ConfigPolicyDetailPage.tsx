import { useState, useEffect, useCallback } from 'react';
import {
  ArrowLeft,
  Layers,
  Target,
  Bell,
  Wrench,
  ClipboardCheck,
  PackageCheck,
  Zap,
  Link2,
  HardDrive,
  Shield,
  ShieldCheck,
  ShieldAlert,
  KeyRound,
  ScrollText,
  ScanSearch,
  Usb,
  Activity,
  LifeBuoy,
  Monitor,
  ListChecks,
  Info,
} from 'lucide-react';
import Breadcrumbs from '../layout/Breadcrumbs';
import { cn } from '@/lib/utils';
import { extractApiError } from '@/lib/apiError';
import { OverflowTabs } from '../shared/OverflowTabs';
import { fetchWithAuth } from '../../stores/auth';
// The web layer only aliases the bare `@breeze/shared` root and the
// `/reportPdf` subpath (see apps/web/vitest.config.ts + tsconfig.json) — the
// `/constants` subpath isn't wired up here, so import from the root, which
// re-exports it.
import { ORG_SCOPED_ONLY_FEATURE_TYPES } from '@breeze/shared';
import type { FeatureType, FeatureLink } from './featureTabs/types';
import { FEATURE_META } from './featureTabs/types';
import { useFeatureLink } from './featureTabs/useFeatureLink';
import AssignmentsTab from './AssignmentsTab';
import PatchTab from './featureTabs/PatchTab';
import AlertRuleTab from './featureTabs/AlertRuleTab';
import BackupTab from './featureTabs/BackupTab';
import SecurityTab from './featureTabs/SecurityTab';
import MaintenanceTab from './featureTabs/MaintenanceTab';
import ComplianceTab from './featureTabs/ComplianceTab';
import AutomationTab from './featureTabs/AutomationTab';
import EventLogTab from './featureTabs/EventLogTab';
import SoftwarePolicyTab from './featureTabs/SoftwarePolicyTab';
import SensitiveDataTab from './featureTabs/SensitiveDataTab';
import PeripheralControlTab from './featureTabs/PeripheralControlTab';
import MonitoringTab from './featureTabs/MonitoringTab';
import WarrantyTab from './featureTabs/WarrantyTab';
import HelperTab from './featureTabs/HelperTab';
import RemoteAccessTab from './featureTabs/RemoteAccessTab';
import PamTab from './featureTabs/PamTab';
import VulnerabilityTab from './featureTabs/VulnerabilityTab';
import ComplianceStatusTab from './ComplianceStatusTab';

type Tab = 'overview' | FeatureType | 'assignments' | 'compliance_status';

type PolicyDetail = {
  id: string;
  name: string;
  description?: string;
  status: 'active' | 'inactive' | 'archived';
  orgId: string | null;
  partnerId: string | null;
  createdAt?: string;
  updatedAt?: string;
  featureLinks: FeatureLink[];
};

const statusConfig: Record<string, { label: string; color: string }> = {
  active: { label: 'Active', color: 'bg-success/15 text-success border-success/30' },
  inactive: { label: 'Inactive', color: 'bg-warning/15 text-warning border-warning/30' },
  archived: { label: 'Archived', color: 'bg-muted text-muted-foreground border-border' },
};

// Exhaustive over FeatureType (full Record, not Partial) so a new canonical
// feature type fails to compile until it gets a tab-bar icon. (#2004)
const featureTabIcons: Record<FeatureType, React.ReactNode> = {
  patch: <PackageCheck className="h-4 w-4" />,
  alert_rule: <Bell className="h-4 w-4" />,
  backup: <HardDrive className="h-4 w-4" />,
  security: <Shield className="h-4 w-4" />,
  maintenance: <Wrench className="h-4 w-4" />,
  compliance: <ClipboardCheck className="h-4 w-4" />,
  automation: <Zap className="h-4 w-4" />,
  event_log: <ScrollText className="h-4 w-4" />,
  software_policy: <PackageCheck className="h-4 w-4" />,
  sensitive_data: <ScanSearch className="h-4 w-4" />,
  peripheral_control: <Usb className="h-4 w-4" />,
  monitoring: <Activity className="h-4 w-4" />,
  warranty: <ShieldCheck className="h-4 w-4" />,
  helper: <LifeBuoy className="h-4 w-4" />,
  remote_access: <Monitor className="h-4 w-4" />,
  pam: <KeyRound className="h-4 w-4" />,
  vulnerability: <ShieldAlert className="h-4 w-4" />,
};

// Which feature tabs the editor renders, in display order. Derived from
// FEATURE_META keys (not a hand-listed subset) so it stays in lockstep with the
// canonical registry and can't silently omit a tab — previously this was a hand
// list that had drifted, dropping `security` so SecurityTab was unreachable even
// though it's imported, wired into renderFeatureTab, and has a baseline. (#2004)
// featureTypeParity.test.ts asserts this equals canonical minus the exclusions.
export const FEATURE_TYPES = Object.keys(FEATURE_META) as FeatureType[];

type ConfigPolicyDetailPageProps = {
  policyId?: string;
};

export default function ConfigPolicyDetailPage({ policyId }: ConfigPolicyDetailPageProps) {
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [policy, setPolicy] = useState<PolicyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  // Overview edit state
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editStatus, setEditStatus] = useState('active');
  const [saving, setSaving] = useState(false);

  // Feature links state (fetched on mount, not gated by active tab)
  const [featureLinks, setFeatureLinks] = useState<FeatureLink[]>([]);

  // Removal affordance for a leftover feature link on a gated (org-only) tab —
  // see the gated hint panel below. Partner-wide policies can't author these
  // features, but a link may pre-date the restriction (or arrive via backfill);
  // the editor is never rendered for gated tabs, so without this the link
  // would be stuck with no way to view or remove it.
  const {
    remove: removeGatedLink,
    saving: removingGatedLink,
    error: gatedRemoveError,
  } = useFeatureLink(policyId ?? '');

  // Policy-level linked configuration policy (set once at creation time via ?linked= query param)
  const [linkedPolicyId, setLinkedPolicyId] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      return params.get('linked') || null;
    }
    return null;
  });
  const [linkedPolicyName, setLinkedPolicyName] = useState<string | null>(null);
  const [parentFeatureLinks, setParentFeatureLinks] = useState<FeatureLink[]>([]);

  const fetchPolicy = useCallback(async () => {
    if (!policyId) return;
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth(`/configuration-policies/${policyId}`);
      if (!response.ok) {
        const errBody = await response.json().catch(() => null);
        throw new Error(extractApiError(errBody, 'Failed to fetch policy'));
      }
      const data = await response.json();
      setPolicy(data);
      setEditName(data.name);
      setEditDescription(data.description ?? '');
      setEditStatus(data.status);
      setFeatureLinks(data.featureLinks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [policyId]);

  const fetchFeatureLinks = useCallback(async () => {
    if (!policyId) return;
    try {
      const response = await fetchWithAuth(`/configuration-policies/${policyId}/features`);
      if (!response.ok) {
        const errBody = await response.json().catch(() => null);
        throw new Error(extractApiError(errBody, 'Failed to fetch features'));
      }
      const data = await response.json();
      setFeatureLinks(Array.isArray(data.data) ? data.data : []);
    } catch {
      // silent — feature links already loaded from policy fetch
    }
  }, [policyId]);

  useEffect(() => {
    fetchPolicy();
  }, [fetchPolicy]);

  // Fetch feature links eagerly on mount
  useEffect(() => {
    fetchFeatureLinks();
  }, [fetchFeatureLinks]);

  // linkedPolicyId is only set via ?linked= query param (parent policy inheritance).
  // featurePolicyId on individual feature links points to standalone entities
  // (backup configs, patch policies, etc.) — not parent configuration policies.

  // Resolve linked policy name and fetch parent's feature links
  useEffect(() => {
    if (!linkedPolicyId) {
      setLinkedPolicyName(null);
      setParentFeatureLinks([]);
      return;
    }
    let cancelled = false;
    fetchWithAuth(`/configuration-policies/${linkedPolicyId}`).then(async (res) => {
      if (!res.ok || cancelled) return;
      const data = await res.json();
      if (!cancelled) {
        setLinkedPolicyName(data.name ?? null);
        setParentFeatureLinks(Array.isArray(data.featureLinks) ? data.featureLinks : []);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [linkedPolicyId]);

  const handleSaveOverview = async () => {
    if (!policyId) return;
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/configuration-policies/${policyId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName,
          description: editDescription || undefined,
          status: editStatus,
        }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(extractApiError(data, 'Failed to update policy'));
      }
      const updated = await response.json();
      setPolicy(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSaving(false);
    }
  };

  const handleLinkChanged = useCallback(
    (link: FeatureLink | null, featureType: FeatureType) => {
      setFeatureLinks((prev) => {
        if (link === null) {
          // Remove
          return prev.filter((l) => l.featureType !== featureType);
        }
        const idx = prev.findIndex((l) => l.featureType === featureType);
        if (idx >= 0) {
          // Update
          const next = [...prev];
          next[idx] = link;
          return next;
        }
        // Add
        return [...prev, link];
      });
    },
    []
  );

  const linkFor = (t: FeatureType) => featureLinks.find((l) => l.featureType === t);
  const parentLinkFor = (t: FeatureType) => parentFeatureLinks.find((l) => l.featureType === t);

  // Partner-wide ("all organizations") policies carry orgId === null (#1724).
  // A fixed, small set of feature types are fundamentally org-scoped (backup
  // storage credentials carry an org_id FK) and are rejected with a 400 by the
  // API if saved on a partner-wide policy — see ORG_SCOPED_ONLY_FEATURE_TYPES
  // in @breeze/shared/constants, the single source of truth shared with
  // apps/api/src/routes/configurationPolicies/featureLinks.ts. Gate those tabs
  // here so the UI never offers an edit that can't be saved (#2101).
  // `tabs` (and this gating) is computed before the `if (!policy) return null`
  // guard below, so `policy` may still be null while the initial fetch is in
  // flight — optional-chain rather than assume non-null.
  const isPartnerWide = policy?.orgId === null;
  const isOrgOnlyFeature = (ft: FeatureType) => ORG_SCOPED_ONLY_FEATURE_TYPES.has(ft);
  const isGatedFeature = (ft: FeatureType) => isPartnerWide && isOrgOnlyFeature(ft);

  const tabs: { id: Tab; label: string; icon: React.ReactNode; dot?: boolean; title?: string }[] = [
    { id: 'overview', label: 'Overview', icon: <Layers className="h-4 w-4" /> },
    ...FEATURE_TYPES.map((ft) => ({
      id: ft as Tab,
      label: FEATURE_META[ft].label,
      icon: featureTabIcons[ft],
      dot: !!linkFor(ft) || !!parentLinkFor(ft),
      title: isGatedFeature(ft)
        ? 'Not available on partner-wide policies — configure this feature on an organization-scoped policy.'
        : undefined,
    })),
    { id: 'compliance_status', label: 'Compliance Status', icon: <ListChecks className="h-4 w-4" /> },
    { id: 'assignments', label: 'Assignments', icon: <Target className="h-4 w-4" /> },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading policy...</p>
        </div>
      </div>
    );
  }

  if (error && !policy) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <a
          href="/configuration-policies"
          className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Back to list
        </a>
      </div>
    );
  }

  if (!policy) return null;

  const renderFeatureTab = (ft: FeatureType) => {
    const props = {
      policyId: policyId!,
      existingLink: linkFor(ft),
      onLinkChanged: handleLinkChanged,
      linkedPolicyId,
      parentLink: parentLinkFor(ft),
    };
    switch (ft) {
      case 'patch': return <PatchTab {...props} />;
      case 'alert_rule': return <AlertRuleTab {...props} />;
      case 'backup': return <BackupTab {...props} />;
      case 'security': return <SecurityTab {...props} />;
      case 'maintenance': return <MaintenanceTab {...props} />;
      case 'compliance': return <ComplianceTab {...props} />;
      case 'automation': return <AutomationTab {...props} />;
      case 'event_log': return <EventLogTab {...props} />;
      case 'software_policy': return <SoftwarePolicyTab {...props} />;
      case 'sensitive_data': return <SensitiveDataTab {...props} />;
      case 'monitoring': return <MonitoringTab {...props} />;
      case 'peripheral_control': return <PeripheralControlTab {...props} />;
      case 'warranty': return <WarrantyTab {...props} />;
      case 'helper': return <HelperTab {...props} />;
      case 'remote_access': return <RemoteAccessTab {...props} />;
      case 'pam': return <PamTab {...props} />;
      case 'vulnerability': return <VulnerabilityTab {...props} />;
    }
  };

  return (
    <div className="space-y-6">
      <Breadcrumbs items={[
        { label: 'Configuration Policies', href: '/configuration-policies' },
        { label: policy.name || 'Policy' }
      ]} />
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <a
            href="/configuration-policies"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" />
          </a>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-semibold tracking-tight">{policy.name}</h1>
              <span
                className={cn(
                  'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                  statusConfig[policy.status]?.color
                )}
              >
                {statusConfig[policy.status]?.label}
              </span>
            </div>
            {policy.description && (
              <p className="mt-1 text-sm text-muted-foreground">{policy.description}</p>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Tabs */}
      <OverflowTabs tabs={tabs} activeTab={activeTab} onTabChange={(id) => setActiveTab(id as Tab)} />

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <h2 className="text-lg font-semibold">Policy Details</h2>
          <div className="mt-4 grid gap-4">
            <div>
              <label className="text-sm font-medium">Name</label>
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Description</label>
              <textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                className="mt-2 h-20 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Status</label>
              <select
                value={editStatus}
                onChange={(e) => setEditStatus(e.target.value)}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-48"
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="archived">Archived</option>
              </select>
            </div>
          </div>
          <div className="mt-6 flex justify-end">
            <button
              type="button"
              onClick={handleSaveOverview}
              disabled={saving}
              className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      )}

      {/* Parent policy banner — shown on feature tabs when inheriting from another policy */}
      {FEATURE_TYPES.includes(activeTab as FeatureType) &&
        linkedPolicyId &&
        !isGatedFeature(activeTab as FeatureType) && (
        <div className="flex items-center rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3">
          <div className="flex items-center gap-2 text-sm">
            <Link2 className="h-4 w-4 text-blue-600" />
            <span className="font-medium text-blue-700">
              Inheriting from{' '}
              <a
                href={`/configuration-policies/${linkedPolicyId}`}
                className="underline underline-offset-2 hover:text-blue-900"
              >
                {linkedPolicyName || 'parent policy'}
              </a>
            </span>
            <span className="text-xs text-blue-600/70">
              — Override individual tabs to customize settings
            </span>
          </div>
        </div>
      )}

      {/* Feature Tabs — org-only features (e.g. Backup) are rendered read-only
          with an inline hint on partner-wide policies instead of the editor,
          since the API rejects that save with a 400 (#2101). */}
      {FEATURE_TYPES.includes(activeTab as FeatureType) && (
        isGatedFeature(activeTab as FeatureType) ? (
          <div className="flex items-start gap-3 rounded-lg border border-dashed bg-muted/30 p-6 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium text-foreground">
                {FEATURE_META[activeTab as FeatureType].label} isn&apos;t available on partner-wide policies
              </p>
              <p className="mt-1">Configure this feature on an organization-scoped policy.</p>
              {/* A gated tab never renders its editor, so a leftover link
                  (pre-dating the restriction) needs a removal path here or it
                  would be permanently stuck. */}
              {linkFor(activeTab as FeatureType) && (
                <div className="mt-4">
                  <p className="text-warning">
                    This policy still carries an existing{' '}
                    {FEATURE_META[activeTab as FeatureType].label.toLowerCase()} configuration that
                    will never be applied.
                  </p>
                  {gatedRemoveError && (
                    <p className="mt-2 text-destructive">{gatedRemoveError}</p>
                  )}
                  <button
                    type="button"
                    disabled={removingGatedLink}
                    onClick={async () => {
                      const ft = activeTab as FeatureType;
                      const link = linkFor(ft);
                      if (!link) return;
                      const ok = await removeGatedLink(link.id);
                      if (ok) handleLinkChanged(null, ft);
                    }}
                    className="mt-2 h-9 rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
                  >
                    {removingGatedLink ? 'Removing...' : 'Remove configuration'}
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          renderFeatureTab(activeTab as FeatureType)
        )
      )}

      {/* Compliance Status Tab (read-only results; the `compliance` feature tab is the rule editor) */}
      {activeTab === 'compliance_status' && policyId && (
        <ComplianceStatusTab policyId={policyId} />
      )}

      {/* Assignments Tab */}
      {activeTab === 'assignments' && policyId && policy && (
        <AssignmentsTab policyId={policyId} orgId={policy.orgId} partnerId={policy.partnerId} />
      )}
    </div>
  );
}
