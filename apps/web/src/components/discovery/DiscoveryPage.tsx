import { useCallback, useMemo, useState, useEffect } from 'react';
import { Plus, X } from 'lucide-react';
import DiscoveryProfileList, { type DiscoveryProfile, type DiscoveryProfileStatus } from './DiscoveryProfileList';
import DiscoveryProfileForm, { type DiscoveryProfileFormValues, type DiscoverySchedule, type SnmpSettings, type ProfileAlertSettings, defaultAlertSettings } from './DiscoveryProfileForm';
import DiscoveryJobList from './DiscoveryJobList';
import DiscoveredAssetList from './DiscoveredAssetList';
import AssetDetailModal, { type AssetDetail } from './AssetDetailModal';
import NetworkTopologyMap from './NetworkTopologyMap';
import NetworkChangesPanel from './NetworkChangesPanel';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

const DISCOVERY_TABS = ['assets', 'profiles', 'jobs', 'topology', 'changes'] as const;
type DiscoveryTab = (typeof DISCOVERY_TABS)[number];

type ApiDiscoverySchedule = {
  type: 'manual' | 'cron' | 'interval';
  cron?: string;
  intervalMinutes?: number;
  timezone?: string;
};

type ApiSnmpCredentials = {
  version?: string;
  port?: number;
  timeout?: number;
  retries?: number;
  username?: string;
  authProtocol?: string;
  authPassphrase?: string;
  privacyProtocol?: string;
  privacyPassphrase?: string;
};

type ApiDiscoveryProfile = {
  id: string;
  name: string;
  siteId: string;
  subnets: string[];
  methods: string[];
  schedule?: ApiDiscoverySchedule;
  snmpCommunities?: string[];
  snmpCredentials?: ApiSnmpCredentials | null;
  alertSettings?: ProfileAlertSettings | null;
  createdAt?: string;
  updatedAt?: string;
};

const fallbackSchedule: DiscoverySchedule = {
  cadence: 'daily',
  intervalHours: 1,
  intervalMinutes: 60,
  time: '02:00',
  dayOfWeek: 'Monday',
  dayOfMonth: '1',
  timezone: 'UTC'
};

const dayLabels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parseDayOfWeek(value: string) {
  const normalized = value.trim().toUpperCase();
  if (/^\d+$/.test(normalized)) {
    const index = Number(normalized);
    const map: Record<number, string> = {
      0: 'Sunday',
      1: 'Monday',
      2: 'Tuesday',
      3: 'Wednesday',
      4: 'Thursday',
      5: 'Friday',
      6: 'Saturday',
      7: 'Sunday'
    };
    return map[index] ?? 'Monday';
  }

  const shortMap: Record<string, string> = {
    SUN: 'Sunday',
    MON: 'Monday',
    TUE: 'Tuesday',
    WED: 'Wednesday',
    THU: 'Thursday',
    FRI: 'Friday',
    SAT: 'Saturday'
  };

  return shortMap[normalized] ?? 'Monday';
}

function parseCronSchedule(cron?: string) {
  if (!cron) return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 2) return null;

  const [minute, hour, dayOfMonth = '*', _month = '*', dayOfWeek = '*'] = parts;
  const safeHour = hour.padStart(2, '0');
  const safeMinute = minute.padStart(2, '0');
  const time = `${safeHour}:${safeMinute}`;

  if (dayOfMonth !== '*' && dayOfMonth !== '?') {
    return { cadence: 'monthly' as const, time, dayOfMonth };
  }

  if (dayOfWeek !== '*' && dayOfWeek !== '?') {
    return { cadence: 'weekly' as const, time, dayOfWeek: parseDayOfWeek(dayOfWeek) };
  }

  return { cadence: 'daily' as const, time };
}

function scheduleToForm(schedule?: ApiDiscoverySchedule): DiscoverySchedule {
  if (!schedule) return { ...fallbackSchedule };
  if (schedule.type === 'cron') {
    const parsed = parseCronSchedule(schedule.cron);
    if (parsed) {
      return {
        ...fallbackSchedule,
        ...parsed,
        timezone: schedule.timezone?.trim() || fallbackSchedule.timezone,
        dayOfWeek: parsed.cadence === 'weekly' ? parsed.dayOfWeek : fallbackSchedule.dayOfWeek,
        dayOfMonth: parsed.cadence === 'monthly' ? parsed.dayOfMonth : fallbackSchedule.dayOfMonth
      };
    }
  }

  if (schedule.type === 'interval' && schedule.intervalMinutes) {
    if (schedule.intervalMinutes % 60 !== 0) {
      return {
        ...fallbackSchedule,
        cadence: 'interval',
        intervalMinutes: Math.max(1, schedule.intervalMinutes)
      };
    }

    return {
      ...fallbackSchedule,
      cadence: 'hourly',
      intervalMinutes: schedule.intervalMinutes,
      intervalHours: Math.max(1, Math.round(schedule.intervalMinutes / 60))
    };
  }

  return { ...fallbackSchedule };
}

function scheduleToDisplay(schedule?: ApiDiscoverySchedule): { label: string; status: DiscoveryProfileStatus } {
  if (!schedule) return { label: 'Manual', status: 'draft' };

  if (schedule.type === 'manual') {
    return { label: 'Manual', status: 'draft' };
  }

  if (schedule.type === 'interval') {
    const minutes = schedule.intervalMinutes ?? 0;
    if (minutes > 0 && minutes % 60 === 0) {
      const hours = minutes / 60;
      return { label: hours === 1 ? 'Every hour' : `Every ${hours} hours`, status: 'active' };
    }
    return { label: minutes ? `Every ${minutes} min` : 'Interval schedule', status: 'active' };
  }

  const parsed = parseCronSchedule(schedule.cron);
  if (!parsed) {
    return { label: schedule.cron ? `Cron: ${schedule.cron}` : 'Cron schedule', status: 'active' };
  }

  switch (parsed.cadence) {
    case 'weekly':
      return { label: `Weekly on ${parsed.dayOfWeek} at ${parsed.time}`, status: 'active' };
    case 'monthly':
      return { label: `Monthly on ${parsed.dayOfMonth} at ${parsed.time}`, status: 'active' };
    default:
      return { label: `Daily at ${parsed.time}`, status: 'active' };
  }
}

function formScheduleToApi(schedule: DiscoverySchedule): ApiDiscoverySchedule {
  if (schedule.cadence === 'interval') {
    const intervalMinutes = Math.max(1, schedule.intervalMinutes ?? 30);
    return { type: 'interval', intervalMinutes };
  }

  if (schedule.cadence === 'hourly') {
    const intervalHours = Math.max(1, schedule.intervalHours ?? 1);
    return { type: 'interval', intervalMinutes: intervalHours * 60 };
  }

  const [hour, minute] = schedule.time.split(':');
  const safeHour = (hour ?? '00').padStart(2, '0');
  const safeMinute = (minute ?? '00').padStart(2, '0');

  let cron = `${safeMinute} ${safeHour} * * *`;
  if (schedule.cadence === 'weekly') {
    const dayIndex = dayLabels.findIndex(day => day === schedule.dayOfWeek);
    cron = `${safeMinute} ${safeHour} * * ${dayIndex >= 0 ? dayIndex : 1}`;
  }
  if (schedule.cadence === 'monthly') {
    const parsedDay = Number(schedule.dayOfMonth ?? '1');
    const safeDay = Number.isFinite(parsedDay) ? Math.min(28, Math.max(1, Math.trunc(parsedDay))) : 1;
    cron = `${safeMinute} ${safeHour} ${safeDay} * *`;
  }

  return { type: 'cron', cron, timezone: schedule.timezone || 'UTC' };
}

function mapProfileToDisplay(profile: ApiDiscoveryProfile): DiscoveryProfile {
  const schedule = scheduleToDisplay(profile.schedule);
  return {
    id: profile.id,
    name: profile.name,
    subnets: profile.subnets ?? [],
    methods: profile.methods ?? [],
    schedule: schedule.label,
    status: schedule.status
  };
}

function getTabFromURL(): DiscoveryTab {
  if (typeof window === 'undefined') return 'assets';
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab');
  if (tab && (DISCOVERY_TABS as readonly string[]).includes(tab)) {
    return tab as DiscoveryTab;
  }
  return 'assets';
}

function pushTabToURL(tab: DiscoveryTab) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (tab === 'assets') {
    url.searchParams.delete('tab');
  } else {
    url.searchParams.set('tab', tab);
  }
  window.history.pushState({ tab }, '', url.toString());
}

export default function DiscoveryPage() {
  const [activeTab, setActiveTab] = useState<DiscoveryTab>('assets');

  // Sync tab from URL after hydration + listen for back/forward
  useEffect(() => {
    setActiveTab(getTabFromURL());
    const onPopState = () => setActiveTab(getTabFromURL());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const [profiles, setProfiles] = useState<ApiDiscoveryProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [profilesError, setProfilesError] = useState<string>();
  const [profileFormError, setProfileFormError] = useState<string>();
  const [savingProfile, setSavingProfile] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<ApiDiscoveryProfile | null>(null);
  const [jobsProfileFilter, setJobsProfileFilter] = useState<string | null>(null);
  const [topologyAssetId, setTopologyAssetId] = useState<string | null>(null);
  const [topologyAsset, setTopologyAsset] = useState<AssetDetail | null>(null);
  const [topologyAssetLoading, setTopologyAssetLoading] = useState(false);

  // Fetch asset detail when a topology node is clicked
  useEffect(() => {
    if (!topologyAssetId) {
      setTopologyAsset(null);
      return;
    }
    let cancelled = false;
    setTopologyAssetLoading(true);
    fetchWithAuth(`/discovery/assets/${topologyAssetId}`)
      .then(async res => {
        if (cancelled) return;
        if (!res.ok) {
          setTopologyAsset(null);
          return;
        }
        const data = await res.json();
        const asset = data.data ?? data.asset ?? data;
        if (!cancelled) setTopologyAsset(asset as AssetDetail);
      })
      .catch(() => {
        if (!cancelled) setTopologyAsset(null);
      })
      .finally(() => {
        if (!cancelled) setTopologyAssetLoading(false);
      });
    return () => { cancelled = true; };
  }, [topologyAssetId]);

  const tabLabels: Record<DiscoveryTab, string> = {
    profiles: 'Profiles',
    jobs: 'Jobs',
    assets: 'Assets',
    topology: 'Topology',
    changes: 'Changes'
  };
  const tabButtons = DISCOVERY_TABS.map((id) => ({ id, label: tabLabels[id] }));

  const fetchProfiles = useCallback(async () => {
    try {
      setProfilesLoading(true);
      setProfilesError(undefined);
      const response = await fetchWithAuth('/discovery/profiles');
      if (!response.ok) {
        throw new Error('Failed to fetch discovery profiles');
      }
      const data = await response.json();
      setProfiles(data.data ?? data.profiles ?? data ?? []);
    } catch (err) {
      setProfilesError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setProfilesLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  const displayProfiles = useMemo(() => profiles.map(mapProfileToDisplay), [profiles]);

  const { currentOrgId, currentSiteId, sites } = useOrgStore();
  const siteOptions = useMemo(() => sites.map(s => ({ id: s.id, name: s.name })), [sites]);

  const formInitialValues = useMemo<DiscoveryProfileFormValues | undefined>(() => {
    if (!editingProfile) return undefined;

    const creds = editingProfile.snmpCredentials;
    const community = editingProfile.snmpCommunities?.[0] ?? 'public';
    const version = (creds?.version === 'v3' ? 'v3' : 'v2c') as SnmpSettings['version'];

    const snmp: SnmpSettings = {
      version,
      community,
      port: creds?.port ?? 161,
      timeout: creds?.timeout ?? 2000,
      retries: creds?.retries ?? 1,
      username: creds?.username ?? '',
      authProtocol: (creds?.authProtocol === 'md5' ? 'md5' : 'sha') as SnmpSettings['authProtocol'],
      authPassphrase: creds?.authPassphrase ?? '',
      privacyProtocol: (creds?.privacyProtocol === 'des' ? 'des' : 'aes') as SnmpSettings['privacyProtocol'],
      privacyPassphrase: creds?.privacyPassphrase ?? ''
    };

    return {
      name: editingProfile.name,
      siteId: editingProfile.siteId ?? currentSiteId ?? '',
      subnets: editingProfile.subnets ?? [],
      methods: editingProfile.methods ?? [],
      schedule: scheduleToForm(editingProfile.schedule),
      snmp,
      alertSettings: editingProfile.alertSettings ?? defaultAlertSettings
    };
  }, [editingProfile, currentSiteId]);

  const handleSubmitProfile = async (values: DiscoveryProfileFormValues) => {
    setSavingProfile(true);
    setProfileFormError(undefined);

    if (!values.siteId) {
      setProfileFormError('Please select a site for this discovery profile.');
      setSavingProfile(false);
      return;
    }

    if (values.snmp.version === 'v3') {
      if (!values.snmp.username?.trim()) {
        setProfileFormError('SNMPv3 username is required.');
        setSavingProfile(false);
        return;
      }
      if (!values.snmp.authPassphrase?.trim()) {
        setProfileFormError('SNMPv3 auth passphrase is required.');
        setSavingProfile(false);
        return;
      }
    }

    try {
      const snmpCommunities = values.snmp.version === 'v2c' ? [values.snmp.community] : [];

      const snmpCredentials: Record<string, unknown> = {
        version: values.snmp.version,
        port: values.snmp.port,
        timeout: values.snmp.timeout,
        retries: values.snmp.retries
      };

      if (values.snmp.version === 'v3') {
        snmpCredentials.username = values.snmp.username;
        snmpCredentials.authProtocol = values.snmp.authProtocol;
        snmpCredentials.authPassphrase = values.snmp.authPassphrase;
        snmpCredentials.privacyProtocol = values.snmp.privacyProtocol;
        snmpCredentials.privacyPassphrase = values.snmp.privacyPassphrase;
      }

      const payload = {
        name: values.name,
        subnets: values.subnets,
        methods: values.methods,
        schedule: formScheduleToApi(values.schedule),
        siteId: values.siteId,
        snmpCommunities,
        snmpCredentials,
        alertSettings: values.alertSettings,
        ...(currentOrgId ? { orgId: currentOrgId } : {})
      };

      const url = editingProfile
        ? `/discovery/profiles/${editingProfile.id}`
        : '/discovery/profiles';
      const method = editingProfile ? 'PATCH' : 'POST';

      const response = await fetchWithAuth(url, {
        method,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error ?? 'Failed to save profile');
      }

      await fetchProfiles();
      setEditingProfile(null);
      setIsProfileModalOpen(false);
      setProfileFormError(undefined);
    } catch (err) {
      setProfileFormError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSavingProfile(false);
    }
  };

  const handleDeleteProfile = async (profile: DiscoveryProfile) => {
    if (!confirm(`Delete profile "${profile.name}"? This will also remove all associated scan jobs.`)) {
      return;
    }

    setProfilesError(undefined);

    try {
      const response = await fetchWithAuth(`/discovery/profiles/${profile.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('Failed to delete profile');
      }

      await fetchProfiles();
    } catch (err) {
      setProfilesError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const handleRunProfile = async (profile: DiscoveryProfile) => {
    setProfilesError(undefined);

    try {
      const response = await fetchWithAuth('/discovery/scan', {
        method: 'POST',
        body: JSON.stringify({ profileId: profile.id })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error ?? 'Failed to run discovery profile');
      }

      // Switch to jobs tab filtered to this profile so user can see the queued scan
      setJobsProfileFilter(profile.id);
      navigateToTab('jobs');
    } catch (err) {
      setProfilesError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const handleEditProfile = async (profile: DiscoveryProfile) => {
    setProfilesError(undefined);
    setProfileFormError(undefined);
    try {
      const response = await fetchWithAuth(`/discovery/profiles/${profile.id}`);
      if (!response.ok) {
        if (response.status === 404) {
          // Detail endpoint not available; fall back to list data with warning
          const match = profiles.find(item => item.id === profile.id);
          if (!match) {
            setProfilesError('This profile may have been deleted. Please refresh the page.');
            return;
          }
          setEditingProfile(match);
          setProfilesError('Profile detail endpoint unavailable. SNMP credentials may not be loaded.');
          setIsProfileModalOpen(true);
          return;
        }
        const errData = await response.json().catch(() => null);
        throw new Error(errData?.error ?? `Failed to load profile details (HTTP ${response.status})`);
      }
      const data = await response.json();
      const fullProfile: ApiDiscoveryProfile = data.data ?? data.profile ?? data;
      setEditingProfile(fullProfile);
      setIsProfileModalOpen(true);
    } catch (err) {
      setProfilesError(err instanceof Error ? err.message : 'Failed to load profile details');
    }
  };

  const navigateToTab = useCallback((tab: DiscoveryTab) => {
    setActiveTab(tab);
    pushTabToURL(tab);
  }, []);

  const handleNavigateToJobs = useCallback((profileId: string) => {
    setJobsProfileFilter(profileId);
    navigateToTab('jobs');
  }, [navigateToTab]);

  const handleNavigateToProfiles = useCallback(() => {
    navigateToTab('profiles');
  }, [navigateToTab]);

  const handleNavigateToAssets = useCallback(() => {
    navigateToTab('assets');
  }, [navigateToTab]);

  // Clear filters when manually clicking a tab
  const handleTabClick = useCallback((tab: DiscoveryTab) => {
    if (tab === 'jobs') setJobsProfileFilter(null);
    navigateToTab(tab);
  }, [navigateToTab]);

  const handleCloseProfileModal = useCallback(() => {
    if (savingProfile) return;
    setIsProfileModalOpen(false);
    setEditingProfile(null);
    setProfileFormError(undefined);
  }, [savingProfile]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Network Discovery</h1>
          <p className="text-muted-foreground">
            Configure discovery profiles, monitor scans, and manage network assets.
          </p>
        </div>
        {activeTab === 'profiles' && (
          <button
            type="button"
            className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
            onClick={() => {
              setEditingProfile(null);
              setProfileFormError(undefined);
              setIsProfileModalOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            New Profile
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {tabButtons.map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => handleTabClick(tab.id)}
            className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
              activeTab === tab.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'profiles' && (
        <DiscoveryProfileList
          profiles={displayProfiles}
          loading={profilesLoading}
          error={profilesError}
          onRetry={fetchProfiles}
          onEdit={handleEditProfile}
          onDelete={handleDeleteProfile}
          onRun={handleRunProfile}
          onViewJobs={handleNavigateToJobs}
        />
      )}

      {activeTab === 'jobs' && (
        <DiscoveryJobList
          profileFilter={jobsProfileFilter}
          onClearFilter={() => setJobsProfileFilter(null)}
          onViewProfile={handleNavigateToProfiles}
          onViewAssets={handleNavigateToAssets}
        />
      )}

      {activeTab === 'assets' && <DiscoveredAssetList />}

      {activeTab === 'topology' && (
        <>
          <NetworkTopologyMap onNodeClick={(nodeId) => setTopologyAssetId(nodeId)} />
          {topologyAssetId && (
            <AssetDetailModal
              open={!!topologyAssetId}
              asset={topologyAsset}
              onClose={() => setTopologyAssetId(null)}
              onDeleted={() => setTopologyAssetId(null)}
              onUpdated={() => {
                // Re-fetch to refresh data
                setTopologyAssetId(prev => prev);
              }}
            />
          )}
        </>
      )}

      {activeTab === 'changes' && (
        <NetworkChangesPanel
          currentOrgId={currentOrgId}
          currentSiteId={currentSiteId}
          siteOptions={siteOptions}
        />
      )}

      {isProfileModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-5xl rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">
                  {editingProfile ? 'Edit Discovery Profile' : 'New Discovery Profile'}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Configure network scope, scan methods, and scheduling settings.
                </p>
              </div>
              <button
                type="button"
                onClick={handleCloseProfileModal}
                className="flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:text-foreground"
                disabled={savingProfile}
                aria-label="Close profile settings modal"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-5 max-h-[calc(100vh-12rem)] overflow-y-auto pr-1">
              <DiscoveryProfileForm
                initialValues={formInitialValues}
                sites={siteOptions}
                onSubmit={handleSubmitProfile}
                onCancel={handleCloseProfileModal}
                submitLabel={editingProfile ? (savingProfile ? 'Updating...' : 'Update Profile') : (savingProfile ? 'Creating...' : 'Create Profile')}
                disabled={savingProfile}
                error={profileFormError}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
