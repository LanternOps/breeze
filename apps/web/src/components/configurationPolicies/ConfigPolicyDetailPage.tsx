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
  ScrollText,
  ScanSearch,
  Usb,
  Activity,
  LifeBuoy,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { OverflowTabs } from '../shared/OverflowTabs';
import { fetchWithAuth } from '../../stores/auth';
import type { FeatureType, FeatureLink } from './featureTabs/types';
import { FEATURE_META } from './featureTabs/types';
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

type Tab = 'overview' | FeatureType | 'assignments';

type PolicyDetail = {
  id: string;
  name: string;
  description?: string;
  status: 'active' | 'inactive' | 'archived';
  orgId: string;
  createdAt?: string;
  updatedAt?: string;
  featureLinks: FeatureLink[];
};

const statusConfig: Record<string, { label: string; color: string }> = {
  active: { label: 'Active', color: 'bg-success/15 text-success border-success/30' },
  inactive: { label: 'Inactive', color: 'bg-warning/15 text-warning border-warning/30' },
  archived: { label: 'Archived', color: 'bg-muted text-muted-foreground border-border' },
};

const featureTabIcons: Partial<Record<FeatureType, React.ReactNode>> = {
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
};

const FEATURE_TYPES: FeatureType[] = ['patch', 'alert_rule', 'backup', 'monitoring', 'maintenance', 'compliance', 'automation', 'event_log', 'software_policy', 'sensitive_data', 'peripheral_control', 'warranty', 'helper'];

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
      if (!response.ok) throw new Error('Failed to fetch policy');
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
      if (!response.ok) throw new Error('Failed to fetch features');
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

  // Sync linkedPolicyId from existing feature links (if not already set from query param)
  useEffect(() => {
    if (linkedPolicyId) return; // already set from query param
    const linkedLink = featureLinks.find((l) => l.featurePolicyId);
    if (linkedLink) {
      setLinkedPolicyId(linkedLink.featurePolicyId);
    }
  }, [featureLinks, linkedPolicyId]);

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
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update policy');
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

  const tabs: { id: Tab; label: string; icon: React.ReactNode; dot?: boolean }[] = [
    { id: 'overview', label: 'Overview', icon: <Layers className="h-4 w-4" /> },
    ...FEATURE_TYPES.map((ft) => ({
      id: ft as Tab,
      label: FEATURE_META[ft].label,
      icon: featureTabIcons[ft],
      dot: !!linkFor(ft) || !!parentLinkFor(ft),
    })),
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
    }
  };

  return (
    <div className="space-y-6">
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
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-semibold">Policy Details</h2>
          <div className="mt-4 grid gap-4">
            <div>
              <label className="text-sm font-medium">Name</label>
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Description</label>
              <textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                className="mt-2 h-20 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Status</label>
              <select
                value={editStatus}
                onChange={(e) => setEditStatus(e.target.value)}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-48"
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
      {FEATURE_TYPES.includes(activeTab as FeatureType) && linkedPolicyId && (
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

      {/* Feature Tabs */}
      {FEATURE_TYPES.includes(activeTab as FeatureType) && renderFeatureTab(activeTab as FeatureType)}

      {/* Assignments Tab */}
      {activeTab === 'assignments' && policyId && policy && (
        <AssignmentsTab policyId={policyId} orgId={policy.orgId} />
      )}
    </div>
  );
}
