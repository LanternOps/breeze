import { useState, useEffect, useCallback } from 'react';
import {
  ArrowLeft,
  Building2,
  MapPin,
  FileText,
  Monitor,
  Trash2,
  Plus,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import Breadcrumbs from '../layout/Breadcrumbs';
import { fetchWithAuth } from '../../stores/auth';

// --- Types ---

type SiteDetails = {
  id: string;
  name: string;
  orgId: string;
  timezone: string;
  status: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  deviceCount?: number;
};

type OrgInfo = {
  id: string;
  name: string;
};

type PolicyAssignment = {
  assignment: {
    id: string;
    configPolicyId: string;
    level: string;
    targetId: string;
    priority: number;
    roleFilter?: string[] | null;
    osFilter?: string[] | null;
  };
  policyName: string;
  policyStatus: string;
  policyOrgId: string;
};

type AvailablePolicy = {
  id: string;
  name: string;
  status: string;
};

type TabKey = 'details' | 'policies' | 'devices';

const tabs = [
  { id: 'details' as const, label: 'Details', icon: MapPin },
  { id: 'policies' as const, label: 'Configuration Policies', icon: FileText },
  { id: 'devices' as const, label: 'Devices', icon: Monitor },
];

const VALID_TABS: TabKey[] = tabs.map(t => t.id);

function getTabFromHash(): TabKey {
  if (typeof window === 'undefined') return 'details';
  const hash = window.location.hash.replace('#', '');
  if (VALID_TABS.includes(hash as TabKey)) return hash as TabKey;
  return 'details';
}

const timezoneOptions = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];

const statusBadge: Record<string, { label: string; className: string }> = {
  active: { label: 'Active', className: 'bg-success/15 text-success border-success/30' },
  inactive: { label: 'Inactive', className: 'bg-muted text-muted-foreground border-border' },
};

// Fixed reference time for SSR hydration consistency
const REFERENCE_TIME = '12:00 PM';

const formatTime = (date: Date) =>
  date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

// --- Component ---

export default function SiteDetailPage({ siteId }: { siteId: string }) {
  const [activeTab, setActiveTab] = useState<TabKey>(getTabFromHash);

  useEffect(() => {
    const onHashChange = () => setActiveTab(getTabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const switchTab = (tab: TabKey) => {
    window.location.hash = tab;
    setActiveTab(tab);
  };

  const [site, setSite] = useState<SiteDetails | null>(null);
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  // Details tab form state
  const [formName, setFormName] = useState('');
  const [formTimezone, setFormTimezone] = useState('UTC');
  const [formAddressLine1, setFormAddressLine1] = useState('');
  const [formAddressLine2, setFormAddressLine2] = useState('');
  const [formCity, setFormCity] = useState('');
  const [formState, setFormState] = useState('');
  const [formPostalCode, setFormPostalCode] = useState('');
  const [formCountry, setFormCountry] = useState('');
  const [formContactName, setFormContactName] = useState('');
  const [formContactEmail, setFormContactEmail] = useState('');
  const [formContactPhone, setFormContactPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<{ hasUnsavedChanges: boolean; lastSavedAt: string }>({
    hasUnsavedChanges: false,
    lastSavedAt: REFERENCE_TIME,
  });

  // Policies tab state
  const [assignments, setAssignments] = useState<PolicyAssignment[]>([]);
  const [assignmentsError, setAssignmentsError] = useState<string>();
  const [availablePolicies, setAvailablePolicies] = useState<AvailablePolicy[]>([]);
  const [selectedPolicyId, setSelectedPolicyId] = useState('');
  const [assignPriority, setAssignPriority] = useState('0');
  const [assigning, setAssigning] = useState(false);

  const populateForm = useCallback((s: SiteDetails) => {
    setFormName(s.name ?? '');
    setFormTimezone(s.timezone ?? 'UTC');
    setFormAddressLine1(s.addressLine1 ?? '');
    setFormAddressLine2(s.addressLine2 ?? '');
    setFormCity(s.city ?? '');
    setFormState(s.state ?? '');
    setFormPostalCode(s.postalCode ?? '');
    setFormCountry(s.country ?? '');
    setFormContactName(s.contactName ?? '');
    setFormContactEmail(s.contactEmail ?? '');
    setFormContactPhone(s.contactPhone ?? '');
  }, []);

  const fetchSite = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const res = await fetchWithAuth(`/orgs/sites/${siteId}`);
      if (!res.ok) throw new Error('Failed to fetch site');
      const data = await res.json();
      setSite(data);
      populateForm(data);

      // Fetch org name for breadcrumbs — isolated so failure doesn't crash page load
      if (data.orgId) {
        try {
          const orgRes = await fetchWithAuth(`/orgs/organizations/${data.orgId}`);
          if (orgRes.ok) {
            const orgData = await orgRes.json();
            setOrg({ id: orgData.id, name: orgData.name });
          }
        } catch (orgErr) {
          console.warn('Failed to fetch org for breadcrumbs:', orgErr);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [siteId, populateForm]);

  const fetchAssignments = useCallback(async () => {
    try {
      setAssignmentsError(undefined);
      const res = await fetchWithAuth(
        `/configuration-policies/assignments/target?level=site&targetId=${siteId}`
      );
      if (!res.ok) {
        console.error('Failed to fetch policy assignments:', res.status);
        setAssignmentsError('Could not load policy assignments');
        return;
      }
      const data = await res.json();
      setAssignments(Array.isArray(data.data) ? data.data : []);
    } catch (err) {
      console.error('Failed to fetch policy assignments:', err);
      setAssignmentsError('Could not load policy assignments');
    }
  }, [siteId]);

  const fetchAvailablePolicies = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/configuration-policies?status=active');
      if (!res.ok) {
        console.error('Failed to fetch available policies:', res.status);
        return;
      }
      const data = await res.json();
      setAvailablePolicies(Array.isArray(data.data) ? data.data : []);
    } catch (err) {
      console.error('Failed to fetch available policies:', err);
    }
  }, []);

  useEffect(() => {
    fetchSite();
  }, [fetchSite]);

  useEffect(() => {
    fetchAssignments();
    fetchAvailablePolicies();
  }, [fetchAssignments, fetchAvailablePolicies]);

  // Mark form dirty when any field changes
  const handleFieldChange = (setter: (v: string) => void) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    setter(e.target.value);
    setSaveState((prev) => ({ ...prev, hasUnsavedChanges: true }));
  };

  const handleSaveDetails = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const res = await fetchWithAuth(`/orgs/sites/${siteId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: formName,
          timezone: formTimezone,
          addressLine1: formAddressLine1,
          addressLine2: formAddressLine2 || undefined,
          city: formCity,
          state: formState,
          postalCode: formPostalCode,
          country: formCountry,
          contactName: formContactName,
          contactEmail: formContactEmail,
          contactPhone: formContactPhone,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to save site');
      }
      const updated = await res.json();
      setSite(updated);
      populateForm(updated);
      setSaveState({ hasUnsavedChanges: false, lastSavedAt: formatTime(new Date()) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSaving(false);
    }
  };

  const handleAssignPolicy = async () => {
    if (!selectedPolicyId) return;
    setAssigning(true);
    setError(undefined);
    try {
      const res = await fetchWithAuth(
        `/configuration-policies/${selectedPolicyId}/assignments`,
        {
          method: 'POST',
          body: JSON.stringify({
            level: 'site',
            targetId: siteId,
            priority: Number(assignPriority) || 0,
          }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to assign policy');
      }
      setSelectedPolicyId('');
      setAssignPriority('0');
      await fetchAssignments();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setAssigning(false);
    }
  };

  const handleRemoveAssignment = async (a: PolicyAssignment) => {
    setError(undefined);
    try {
      const res = await fetchWithAuth(
        `/configuration-policies/${a.assignment.configPolicyId}/assignments/${a.assignment.id}`,
        { method: 'DELETE' }
      );
      if (!res.ok) throw new Error('Failed to remove assignment');
      await fetchAssignments();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  // Policies not yet assigned to this site
  const unassignedPolicies = availablePolicies.filter(
    (p) => !assignments.some((a) => a.assignment.configPolicyId === p.id)
  );

  // --- Render ---

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading site...</p>
        </div>
      </div>
    );
  }

  if (error && !site) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <a
          href="/settings/organizations"
          className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Back to organizations
        </a>
      </div>
    );
  }

  if (!site) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">Site not found or could not be loaded.</p>
        <a
          href="/settings/organizations"
          className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Back to organizations
        </a>
      </div>
    );
  }

  const badge = statusBadge[site.status] ?? statusBadge.active;

  const statusLabel = saveState.hasUnsavedChanges
    ? 'Unsaved changes'
    : `Saved at ${saveState.lastSavedAt}`;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      {/* Breadcrumbs */}
      <Breadcrumbs
        items={[
          { label: 'Settings', href: '/settings' },
          { label: 'Organizations', href: '/settings/organizations' },
          ...(org ? [{ label: org.name, href: `/settings/organizations#${org.id}` }] : []),
          { label: site.name },
        ]}
      />

      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <a
            href={org ? `/settings/organizations#${org.id}` : '/settings/organizations'}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" />
          </a>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-semibold tracking-tight">{site.name}</h1>
              <span
                className={cn(
                  'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                  badge.className
                )}
              >
                {badge.label}
              </span>
            </div>
            {org && (
              <p className="mt-1 text-sm text-muted-foreground">
                <Building2 className="mr-1 inline h-3.5 w-3.5" />
                {org.name}
              </p>
            )}
          </div>
        </div>
        {activeTab === 'details' && (
          <div className="flex items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm">
            {saveState.hasUnsavedChanges ? (
              <AlertTriangle className="h-4 w-4 text-amber-500" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            )}
            <span className="text-xs font-medium">{statusLabel}</span>
          </div>
        )}
      </header>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Tabs + Content (sidebar layout) */}
      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <aside className="space-y-2 rounded-lg border bg-card p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Site Settings
          </p>
          <nav className="space-y-1">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => switchTab(tab.id)}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition ${
                    isActive
                      ? 'bg-muted font-semibold text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="space-y-6">
          {/* Details Tab */}
          {activeTab === 'details' && (
            <div className="space-y-6">
              <section className="rounded-lg border bg-card p-6 shadow-sm">
                <h2 className="text-lg font-semibold">Site Information</h2>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Site name</label>
                    <input
                      value={formName}
                      onChange={handleFieldChange(setFormName)}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Timezone</label>
                    <select
                      value={formTimezone}
                      onChange={handleFieldChange(setFormTimezone)}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      {timezoneOptions.map((tz) => (
                        <option key={tz} value={tz}>
                          {tz}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </section>

              <section className="rounded-lg border bg-card p-6 shadow-sm">
                <h2 className="text-lg font-semibold">Address</h2>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div className="space-y-2 md:col-span-2">
                    <label className="text-sm font-medium">Address line 1</label>
                    <input
                      value={formAddressLine1}
                      onChange={handleFieldChange(setFormAddressLine1)}
                      placeholder="123 Market Street"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <label className="text-sm font-medium">Address line 2</label>
                    <input
                      value={formAddressLine2}
                      onChange={handleFieldChange(setFormAddressLine2)}
                      placeholder="Suite 500"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">City</label>
                    <input
                      value={formCity}
                      onChange={handleFieldChange(setFormCity)}
                      placeholder="San Francisco"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">State/Region</label>
                    <input
                      value={formState}
                      onChange={handleFieldChange(setFormState)}
                      placeholder="CA"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Postal code</label>
                    <input
                      value={formPostalCode}
                      onChange={handleFieldChange(setFormPostalCode)}
                      placeholder="94107"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Country</label>
                    <input
                      value={formCountry}
                      onChange={handleFieldChange(setFormCountry)}
                      placeholder="United States"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
              </section>

              <section className="rounded-lg border bg-card p-6 shadow-sm">
                <h2 className="text-lg font-semibold">Primary Contact</h2>
                <div className="mt-4 grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Name</label>
                    <input
                      value={formContactName}
                      onChange={handleFieldChange(setFormContactName)}
                      placeholder="Alex Morgan"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Email</label>
                    <input
                      type="email"
                      value={formContactEmail}
                      onChange={handleFieldChange(setFormContactEmail)}
                      placeholder="alex@company.com"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Phone</label>
                    <input
                      value={formContactPhone}
                      onChange={handleFieldChange(setFormContactPhone)}
                      placeholder="+1 (555) 123-4567"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
              </section>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleSaveDetails}
                  disabled={saving}
                  className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </div>
          )}

          {/* Configuration Policies Tab */}
          {activeTab === 'policies' && (
            <div className="space-y-6">
              {assignmentsError && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {assignmentsError}
                </div>
              )}

              {/* Assigned policies table */}
              <div className="rounded-lg border bg-card p-6 shadow-sm">
                <h2 className="text-lg font-semibold">Assigned Policies</h2>
                {assignments.length === 0 && !assignmentsError ? (
                  <p className="mt-4 text-sm text-muted-foreground">
                    No configuration policies assigned to this site yet.
                  </p>
                ) : (
                  <div className="mt-4 overflow-hidden rounded-md border">
                    <table className="min-w-full divide-y">
                      <thead className="bg-muted/40">
                        <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          <th className="px-4 py-3">Policy Name</th>
                          <th className="px-4 py-3">Status</th>
                          <th className="px-4 py-3">Priority</th>
                          <th className="px-4 py-3 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {assignments.map((a) => (
                          <tr key={a.assignment.id} className="text-sm">
                            <td className="px-4 py-3">
                              <a
                                href={`/configuration-policies/${a.assignment.configPolicyId}`}
                                className="font-medium text-primary hover:underline"
                              >
                                {a.policyName}
                              </a>
                            </td>
                            <td className="px-4 py-3">
                              <span
                                className={cn(
                                  'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                                  a.policyStatus === 'active'
                                    ? 'bg-success/15 text-success border-success/30'
                                    : 'bg-muted text-muted-foreground border-border'
                                )}
                              >
                                {a.policyStatus === 'active' ? 'Active' : 'Inactive'}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-muted-foreground">
                              {a.assignment.priority}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex justify-end">
                                <button
                                  type="button"
                                  onClick={() => handleRemoveAssignment(a)}
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

              {/* Quick-assign form */}
              <div className="rounded-lg border bg-card p-6 shadow-sm">
                <h2 className="text-lg font-semibold">Assign Policy</h2>
                <div className="mt-4 grid gap-4 sm:grid-cols-3">
                  <div>
                    <label className="text-sm font-medium">Policy</label>
                    <select
                      value={selectedPolicyId}
                      onChange={(e) => setSelectedPolicyId(e.target.value)}
                      className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      <option value="">Select a policy...</option>
                      {unassignedPolicies.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-sm font-medium">Priority</label>
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      value={assignPriority}
                      onChange={(e) => setAssignPriority(e.target.value)}
                      className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="flex items-end">
                    <button
                      type="button"
                      onClick={handleAssignPolicy}
                      disabled={assigning || !selectedPolicyId}
                      className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
                    >
                      <Plus className="h-4 w-4" />
                      {assigning ? 'Assigning...' : 'Assign Policy'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Devices Tab */}
          {activeTab === 'devices' && (
            <div className="rounded-lg border bg-card p-6 shadow-sm">
              <h3 className="text-base font-semibold">Devices</h3>
              <p className="mt-2 text-3xl font-bold">{site.deviceCount ?? 0}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                devices assigned to this site
              </p>
              <a
                href="/devices"
                className="mt-4 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                View all devices
              </a>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
