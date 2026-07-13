import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
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
import { useHashTab } from '@/lib/useHashState';
import Breadcrumbs from '../layout/Breadcrumbs';
import { fetchWithAuth } from '../../stores/auth';
import { formatTime as formatUserTime } from '@/lib/dateTimeFormat';

// --- Types ---

// The API stores `address` and `contact` as nested JSONB objects (see the
// `sites` table + `siteContactSchema` in apps/api/src/routes/orgs.ts). The
// form fields below are flat, so populateForm/handleSaveDetails map between
// the two shapes. Sending flat keys would have them silently stripped by the
// route's Zod validation — the bug that made saves appear to reset.
type SiteAddress = {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
};

type SiteContact = {
  name?: string;
  email?: string;
  phone?: string;
};

type SiteDetails = {
  id: string;
  name: string;
  orgId: string;
  timezone: string;
  status: string;
  address?: SiteAddress | null;
  contact?: SiteContact | null;
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
  { id: 'details' as const, labelKey: 'siteDetailPage.tabs.details', icon: MapPin },
  { id: 'policies' as const, labelKey: 'siteDetailPage.tabs.policies', icon: FileText },
  { id: 'devices' as const, labelKey: 'siteDetailPage.tabs.devices', icon: Monitor },
];

const VALID_TABS: TabKey[] = tabs.map(t => t.id);

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

const statusBadge: Record<string, { labelKey: string; className: string }> = {
  active: { labelKey: 'common:states.active', className: 'bg-success/15 text-success border-success/30' },
  inactive: { labelKey: 'common:states.inactive', className: 'bg-muted text-muted-foreground border-border' },
};

// Fixed reference time for SSR hydration consistency
const REFERENCE_TIME = '12:00';

const formatTime = (date: Date) =>
  formatUserTime(date, { locale: 'en-US', hour: 'numeric', minute: '2-digit' });

// --- Component ---

export default function SiteDetailPage({ siteId }: { siteId: string }) {
  const { t } = useTranslation('settings');
  // SSR-safe hash tab (#2421): starts at the default, adopts the hash post-mount.
  const [activeTab, setActiveTab] = useHashTab<TabKey>(VALID_TABS, 'details');

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
    setFormAddressLine1(s.address?.line1 ?? '');
    setFormAddressLine2(s.address?.line2 ?? '');
    setFormCity(s.address?.city ?? '');
    setFormState(s.address?.state ?? '');
    setFormPostalCode(s.address?.postalCode ?? '');
    setFormCountry(s.address?.country ?? '');
    setFormContactName(s.contact?.name ?? '');
    setFormContactEmail(s.contact?.email ?? '');
    setFormContactPhone(s.contact?.phone ?? '');
  }, []);

  const fetchSite = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const res = await fetchWithAuth(`/orgs/sites/${siteId}`);
      if (!res.ok) throw new Error(t('siteDetailPage.errors.fetchSite'));
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
      setError(err instanceof Error ? err.message : t('siteDetailPage.errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [siteId, populateForm, t]);

  const fetchAssignments = useCallback(async () => {
    try {
      setAssignmentsError(undefined);
      const res = await fetchWithAuth(
        `/configuration-policies/assignments/target?level=site&targetId=${siteId}`
      );
      if (!res.ok) {
        console.error('Failed to fetch policy assignments:', res.status);
        setAssignmentsError(t('siteDetailPage.errors.loadAssignments'));
        return;
      }
      const data = await res.json();
      setAssignments(Array.isArray(data.data) ? data.data : []);
    } catch (err) {
      console.error('Failed to fetch policy assignments:', err);
      setAssignmentsError(t('siteDetailPage.errors.loadAssignments'));
    }
  }, [siteId, t]);

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
          address: {
            line1: formAddressLine1,
            line2: formAddressLine2 || undefined,
            city: formCity,
            state: formState,
            postalCode: formPostalCode,
            country: formCountry,
          },
          contact: {
            name: formContactName,
            email: formContactEmail,
            phone: formContactPhone,
          },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || t('siteDetailPage.errors.saveSite'));
      }
      const updated = await res.json();
      setSite(updated);
      populateForm(updated);
      setSaveState({ hasUnsavedChanges: false, lastSavedAt: formatTime(new Date()) });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('siteDetailPage.errors.generic'));
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
        throw new Error(body.error || t('siteDetailPage.errors.assignPolicy'));
      }
      setSelectedPolicyId('');
      setAssignPriority('0');
      await fetchAssignments();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('siteDetailPage.errors.generic'));
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
      if (!res.ok) throw new Error(t('siteDetailPage.errors.removeAssignment'));
      await fetchAssignments();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('siteDetailPage.errors.generic'));
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
          <p className="mt-4 text-sm text-muted-foreground">{t('siteDetailPage.loading')}</p>
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
          {t('siteDetailPage.backToOrganizations')}
        </a>
      </div>
    );
  }

  if (!site) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{t('siteDetailPage.errors.notFound')}</p>
        <a
          href="/settings/organizations"
          className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('siteDetailPage.backToOrganizations')}
        </a>
      </div>
    );
  }

  const badge = statusBadge[site.status] ?? statusBadge.active;

  const statusLabel = saveState.hasUnsavedChanges
    ? t('siteDetailPage.saveStatus.unsaved')
    : t('siteDetailPage.saveStatus.savedAt', { time: saveState.lastSavedAt });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      {/* Breadcrumbs */}
      <Breadcrumbs
        items={[
          { label: t('siteDetailPage.breadcrumbs.settings'), href: '/settings' },
          { label: t('siteDetailPage.breadcrumbs.organizations'), href: '/settings/organizations' },
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
                {t(/* i18n-dynamic */ badge.labelKey)}
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
        <aside className="space-y-2 rounded-lg border bg-card p-4 shadow-xs">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('siteDetailPage.sidebar.title')}
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
                  <span>{t(/* i18n-dynamic */ tab.labelKey)}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="space-y-6">
          {/* Details Tab */}
          {activeTab === 'details' && (
            <div className="space-y-6">
              <section className="rounded-lg border bg-card p-6 shadow-xs">
                <h2 className="text-lg font-semibold">{t('siteDetailPage.details.title')}</h2>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('siteForm.fields.name')}</label>
                    <input
                      value={formName}
                      onChange={handleFieldChange(setFormName)}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('siteForm.fields.timezone')}</label>
                    <select
                      value={formTimezone}
                      onChange={handleFieldChange(setFormTimezone)}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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

              <section className="rounded-lg border bg-card p-6 shadow-xs">
                <h2 className="text-lg font-semibold">{t('siteDetailPage.address.title')}</h2>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div className="space-y-2 md:col-span-2">
                    <label className="text-sm font-medium">{t('siteForm.fields.addressLine1')}</label>
                    <input
                      value={formAddressLine1}
                      onChange={handleFieldChange(setFormAddressLine1)}
                      placeholder={t('siteForm.placeholders.addressLine1')}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <label className="text-sm font-medium">{t('siteForm.fields.addressLine2')}</label>
                    <input
                      value={formAddressLine2}
                      onChange={handleFieldChange(setFormAddressLine2)}
                      placeholder={t('siteForm.placeholders.addressLine2')}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('siteForm.fields.city')}</label>
                    <input
                      value={formCity}
                      onChange={handleFieldChange(setFormCity)}
                      placeholder={t('siteForm.placeholders.city')}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('siteForm.fields.state')}</label>
                    <input
                      value={formState}
                      onChange={handleFieldChange(setFormState)}
                      placeholder={t('siteForm.placeholders.state')}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('siteForm.fields.postalCode')}</label>
                    <input
                      value={formPostalCode}
                      onChange={handleFieldChange(setFormPostalCode)}
                      placeholder={t('siteForm.placeholders.postalCode')}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('siteForm.fields.country')}</label>
                    <input
                      value={formCountry}
                      onChange={handleFieldChange(setFormCountry)}
                      placeholder={t('siteForm.placeholders.country')}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
              </section>

              <section className="rounded-lg border bg-card p-6 shadow-xs">
                <h2 className="text-lg font-semibold">{t('siteForm.primaryContact')}</h2>
                <div className="mt-4 grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('common:labels.name')}</label>
                    <input
                      value={formContactName}
                      onChange={handleFieldChange(setFormContactName)}
                      placeholder={t('siteForm.placeholders.contactName')}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('siteForm.fields.email')}</label>
                    <input
                      type="email"
                      value={formContactEmail}
                      onChange={handleFieldChange(setFormContactEmail)}
                      placeholder={t('siteForm.placeholders.contactEmail')}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('siteForm.fields.phone')}</label>
                    <input
                      value={formContactPhone}
                      onChange={handleFieldChange(setFormContactPhone)}
                      placeholder={t('siteForm.placeholders.contactPhone')}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
                  {saving ? t('common:states.saving') : t('siteDetailPage.actions.saveChanges')}
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
              <div className="rounded-lg border bg-card p-6 shadow-xs">
                <h2 className="text-lg font-semibold">{t('siteDetailPage.policies.assignedTitle')}</h2>
                {assignments.length === 0 && !assignmentsError ? (
                  <p className="mt-4 text-sm text-muted-foreground">
                    {t('siteDetailPage.policies.empty')}
                  </p>
                ) : (
                  <div className="mt-4 overflow-x-auto rounded-md border">
                    <table className="min-w-full divide-y">
                      <thead className="bg-muted/40">
                        <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          <th className="px-4 py-3">{t('siteDetailPage.policies.policyName')}</th>
                          <th className="px-4 py-3">{t('common:labels.status')}</th>
                          <th className="px-4 py-3">{t('siteDetailPage.policies.priority')}</th>
                          <th className="px-4 py-3 text-right">{t('common:labels.actions')}</th>
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
                                {a.policyStatus === 'active' ? t('common:states.active') : t('common:states.inactive')}
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
              <div className="rounded-lg border bg-card p-6 shadow-xs">
                <h2 className="text-lg font-semibold">{t('siteDetailPage.policies.assignTitle')}</h2>
                <div className="mt-4 grid gap-4 sm:grid-cols-3">
                  <div>
                    <label className="text-sm font-medium">{t('siteDetailPage.policies.policy')}</label>
                    <select
                      value={selectedPolicyId}
                      onChange={(e) => setSelectedPolicyId(e.target.value)}
                      className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    >
                      <option value="">{t('siteDetailPage.policies.selectPolicy')}</option>
                      {unassignedPolicies.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-sm font-medium">{t('siteDetailPage.policies.priority')}</label>
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      value={assignPriority}
                      onChange={(e) => setAssignPriority(e.target.value)}
                      className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
                      {assigning ? t('siteDetailPage.policies.assigning') : t('siteDetailPage.policies.assign')}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Devices Tab */}
          {activeTab === 'devices' && (
            <div className="rounded-lg border bg-card p-6 shadow-xs">
              <h3 className="text-base font-semibold">{t('siteDetailPage.devices.title')}</h3>
              <p className="mt-2 text-3xl font-bold">{site.deviceCount ?? 0}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('siteDetailPage.devices.assigned')}
              </p>
              <a
                href="/devices"
                className="mt-4 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                {t('siteDetailPage.devices.viewAll')}
              </a>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
