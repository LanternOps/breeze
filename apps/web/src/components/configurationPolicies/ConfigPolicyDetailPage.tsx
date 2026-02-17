import { useState, useEffect, useCallback } from 'react';
import {
  ArrowLeft,
  Layers,
  Target,
  Trash2,
  Plus,
  Bell,
  Wrench,
  ClipboardCheck,
  PackageCheck,
  Zap,
  Link2,
  HardDrive,
  Shield,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import type { FeatureType, FeatureLink } from './featureTabs/types';
import { FEATURE_META } from './featureTabs/types';
import PatchTab from './featureTabs/PatchTab';
import AlertRuleTab from './featureTabs/AlertRuleTab';
import BackupTab from './featureTabs/BackupTab';
import SecurityTab from './featureTabs/SecurityTab';
import MaintenanceTab from './featureTabs/MaintenanceTab';
import ComplianceTab from './featureTabs/ComplianceTab';
import AutomationTab from './featureTabs/AutomationTab';

type Tab = 'overview' | FeatureType | 'assignments';

type Assignment = {
  id: string;
  level: string;
  targetId: string;
  priority: number;
  assignedBy?: string;
  createdAt?: string;
};

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
  active: { label: 'Active', color: 'bg-green-500/20 text-green-700 border-green-500/40' },
  inactive: { label: 'Inactive', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' },
  archived: { label: 'Archived', color: 'bg-gray-500/20 text-gray-700 border-gray-500/40' },
};

const assignmentLevels = [
  { value: 'partner', label: 'Partner' },
  { value: 'organization', label: 'Organization' },
  { value: 'site', label: 'Site' },
  { value: 'device_group', label: 'Device Group' },
  { value: 'device', label: 'Device' },
];

const featureTabIcons: Partial<Record<FeatureType, React.ReactNode>> = {
  patch: <PackageCheck className="h-4 w-4" />,
  alert_rule: <Bell className="h-4 w-4" />,
  backup: <HardDrive className="h-4 w-4" />,
  security: <Shield className="h-4 w-4" />,
  maintenance: <Wrench className="h-4 w-4" />,
  compliance: <ClipboardCheck className="h-4 w-4" />,
  automation: <Zap className="h-4 w-4" />,
};

const FEATURE_TYPES: FeatureType[] = ['patch', 'alert_rule', 'maintenance', 'compliance', 'automation'];

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

  // Assignments state
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [newLevel, setNewLevel] = useState('organization');
  const [newTargetId, setNewTargetId] = useState('');
  const [newPriority, setNewPriority] = useState('0');
  const [addingAssignment, setAddingAssignment] = useState(false);

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

  const fetchAssignments = useCallback(async () => {
    if (!policyId) return;
    try {
      setAssignmentsLoading(true);
      const response = await fetchWithAuth(`/configuration-policies/${policyId}/assignments`);
      if (!response.ok) throw new Error('Failed to fetch assignments');
      const data = await response.json();
      setAssignments(Array.isArray(data.data) ? data.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setAssignmentsLoading(false);
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

  useEffect(() => {
    if (activeTab === 'assignments') fetchAssignments();
  }, [activeTab, fetchAssignments]);

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

  const handleAddAssignment = async () => {
    if (!policyId || !newTargetId.trim()) return;
    setAddingAssignment(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/configuration-policies/${policyId}/assignments`, {
        method: 'POST',
        body: JSON.stringify({
          level: newLevel,
          targetId: newTargetId.trim(),
          priority: Number(newPriority) || 0,
        }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to add assignment');
      }
      setNewTargetId('');
      setNewPriority('0');
      await fetchAssignments();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setAddingAssignment(false);
    }
  };

  const handleRemoveAssignment = async (assignmentId: string) => {
    if (!policyId) return;
    setError(undefined);
    try {
      const response = await fetchWithAuth(
        `/configuration-policies/${policyId}/assignments/${assignmentId}`,
        { method: 'DELETE' }
      );
      if (!response.ok) throw new Error('Failed to remove assignment');
      await fetchAssignments();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

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
              <h1 className="text-2xl font-bold">{policy.name}</h1>
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
      <div className="border-b">
        <nav className="-mb-px flex gap-4 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition ${
                activeTab === tab.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:border-muted-foreground hover:text-foreground'
              }`}
            >
              {tab.icon}
              {tab.label}
              {tab.dot && (
                <span className="h-2 w-2 rounded-full bg-green-500" />
              )}
            </button>
          ))}
        </nav>
      </div>

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
      {activeTab === 'assignments' && (
        <div className="space-y-6">
          {/* Add Assignment Form */}
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Add Assignment</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <div>
                <label className="text-sm font-medium">Level</label>
                <select
                  value={newLevel}
                  onChange={(e) => setNewLevel(e.target.value)}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {assignmentLevels.map((level) => (
                    <option key={level.value} value={level.value}>
                      {level.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm font-medium">Target ID</label>
                <input
                  value={newTargetId}
                  onChange={(e) => setNewTargetId(e.target.value)}
                  placeholder="UUID of the target"
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Priority</label>
                <input
                  type="number"
                  min={0}
                  max={1000}
                  value={newPriority}
                  onChange={(e) => setNewPriority(e.target.value)}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={handleAddAssignment}
                disabled={addingAssignment || !newTargetId.trim()}
                className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                {addingAssignment ? 'Assigning...' : 'Assign'}
              </button>
            </div>
          </div>

          {/* Assignments List */}
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Current Assignments</h2>
            {assignmentsLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              </div>
            ) : assignments.length === 0 ? (
              <p className="mt-4 text-sm text-muted-foreground">
                No assignments yet. Assign this policy to targets above.
              </p>
            ) : (
              <div className="mt-4 overflow-hidden rounded-md border">
                <table className="min-w-full divide-y">
                  <thead className="bg-muted/40">
                    <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-3">Level</th>
                      <th className="px-4 py-3">Target ID</th>
                      <th className="px-4 py-3">Priority</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {assignments.map((assignment) => (
                      <tr key={assignment.id} className="text-sm">
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center rounded-full border bg-muted/50 px-2.5 py-1 text-xs font-medium capitalize">
                            {assignment.level.replace('_', ' ')}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                          {assignment.targetId}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{assignment.priority}</td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end">
                            <button
                              type="button"
                              onClick={() => handleRemoveAssignment(assignment.id)}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md border text-destructive hover:bg-destructive/10"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
