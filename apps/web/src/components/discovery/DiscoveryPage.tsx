import { useCallback, useMemo, useState, useEffect } from 'react';
import { Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import DiscoveryProfileList, { type DiscoveryProfile, type DiscoveryProfileStatus } from './DiscoveryProfileList';
import DiscoveryProfileForm, { type DiscoveryProfileFormValues, type DiscoverySchedule, type SnmpSettings, type ProfileAlertSettings, defaultAlertSettings } from './DiscoveryProfileForm';
import DiscoveryJobList from './DiscoveryJobList';
import DiscoveredAssetList, { mapAsset, toDetail } from './DiscoveredAssetList';
import AssetDetailModal, { type AssetDetail } from './AssetDetailModal';
import NetworkTopologyMap from './NetworkTopologyMap';
import NetworkChangesPanel from './NetworkChangesPanel';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { useOrgScope } from '@/hooks/useOrgScope';
import { ActionError, runAction } from '../../lib/runAction';
import { navigateTo } from '../../lib/navigation';
import { OrgRequiredState } from '../shared/OrgRequiredState';
import { OrgLoadFailedState } from '../shared/OrgLoadFailedState';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

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
  lastRunAt?: string | null;
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

function scheduleToDisplay(schedule: ApiDiscoverySchedule | undefined, t: TFunction): { label: string; status: DiscoveryProfileStatus } {
  if (!schedule) return { label: t('discoveryPage.schedule.manual'), status: 'draft' };

  if (schedule.type === 'manual') {
    return { label: t('discoveryPage.schedule.manual'), status: 'draft' };
  }

  if (schedule.type === 'interval') {
    const minutes = schedule.intervalMinutes ?? 0;
    if (minutes > 0 && minutes % 60 === 0) {
      const hours = minutes / 60;
      return { label: t('discoveryPage.schedule.everyHours', { count: hours }), status: 'active' };
    }
    return { label: minutes ? t('discoveryPage.schedule.everyMinutes', { count: minutes }) : t('discoveryPage.schedule.interval'), status: 'active' };
  }

  const parsed = parseCronSchedule(schedule.cron);
  if (!parsed) {
    return { label: schedule.cron ? t('discoveryPage.schedule.cronValue', { cron: schedule.cron }) : t('discoveryPage.schedule.cron'), status: 'active' };
  }

  switch (parsed.cadence) {
    case 'weekly':
      return { label: t('discoveryPage.schedule.weekly', { day: t(/* i18n-dynamic */ `discoveryPage.days.${parsed.dayOfWeek.toLowerCase()}`), time: parsed.time }), status: 'active' };
    case 'monthly':
      return { label: t('discoveryPage.schedule.monthly', { day: parsed.dayOfMonth, time: parsed.time }), status: 'active' };
    default:
      return { label: t('discoveryPage.schedule.daily', { time: parsed.time }), status: 'active' };
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

function formatRelativeTime(isoDate: string, t: TFunction): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return t('discoveryPage.relative.justNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('discoveryPage.relative.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('discoveryPage.relative.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t('discoveryPage.relative.daysAgo', { count: days });
  const months = Math.floor(days / 30);
  return t('discoveryPage.relative.monthsAgo', { count: months });
}

function mapProfileToDisplay(profile: ApiDiscoveryProfile, t: TFunction): DiscoveryProfile {
  const schedule = scheduleToDisplay(profile.schedule, t);
  return {
    id: profile.id,
    name: profile.name,
    subnets: profile.subnets ?? [],
    methods: profile.methods ?? [],
    schedule: schedule.label,
    status: schedule.status,
    lastRun: profile.lastRunAt ? formatRelativeTime(profile.lastRunAt, t) : undefined
  };
}

function getTabFromHash(): DiscoveryTab {
  if (typeof window === 'undefined') return 'assets';
  const hash = window.location.hash.replace('#', '');
  if (hash && (DISCOVERY_TABS as readonly string[]).includes(hash)) {
    return hash as DiscoveryTab;
  }
  return 'assets';
}

export default function DiscoveryPage() {
  const { t } = useTranslation('discovery');
  const { currentOrgId, sites, fetchSites, allOrgs } = useOrgStore();
  // "All orgs" mode: a partner/multi-org user who has *explicitly* chosen the
  // All-orgs scope via the switcher. Network discovery is inherently
  // org/site/agent-scoped — the API deliberately refuses an unscoped list
  // request (400 "orgId is required …") rather than fan out across orgs. So
  // instead of firing requests that 400 and surfacing a generic page error
  // (#1727), we render a "select an organization" prompt and skip the
  // org-scoped fetches entirely, matching the Patches page UX. (The refusal is
  // specifically for a partner spanning multiple orgs / system scope —
  // resolveOrgId auto-resolves a single-org partner — but those callers are
  // exactly the ones who can reach the All-orgs scope.)
  //
  // Gate on the store's explicit `allOrgs` intent flag, NOT raw
  // `currentOrgId === null`: the store also reports a *transient* null org on a
  // fresh session before the first org is auto-selected (orgStore.ts:35-43), and
  // keying on the bare null would flash this prompt at single-org users on every
  // cold load before hydration completes.
  const allOrgsMode = allOrgs && currentOrgId === null;
  // Full context resolution for the render gate below. Distinguishes the
  // transient pre-hydration window (loading → render nothing for that frame)
  // from a genuine load failure (error → retry card) and a zero-org partner
  // (empty → org-required prompt), instead of collapsing all three into a
  // permanently blank page.
  const scope = useOrgScope();

  const [activeTab, setActiveTab] = useState<DiscoveryTab>('assets');

  // Sync tab from the hash after hydration + listen for hash changes.
  useEffect(() => {
    setActiveTab(getTabFromHash());
    const onHashChange = () => setActiveTab(getTabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const [profiles, setProfiles] = useState<ApiDiscoveryProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [profilesError, setProfilesError] = useState<string>();
  const [profileFormError, setProfileFormError] = useState<string>();
  const [savingProfile, setSavingProfile] = useState(false);
  const [runningProfileId, setRunningProfileId] = useState<string | null>(null);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<ApiDiscoveryProfile | null>(null);
  const [jobsProfileFilter, setJobsProfileFilter] = useState<string | null>(null);
  const [topologyAssetId, setTopologyAssetId] = useState<string | null>(null);
  const [topologyAsset, setTopologyAsset] = useState<AssetDetail | null>(null);
  const [topologyAssetLoading, setTopologyAssetLoading] = useState(false);

  // Deep link from the unified Devices list (#1322): `?asset=<id>` opens that
  // discovered asset in the detail modal, reusing the topology-node viewer.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const assetId = new URLSearchParams(window.location.search).get('asset');
    if (assetId) setTopologyAssetId(assetId);
  }, []);

  // Fetch asset detail when a topology node is clicked (or via the `?asset=`
  // deep link above). Skip in All-Orgs mode: this asset-detail endpoint is
  // org-scoped too, so an unscoped fetch would 400 just like the list requests.
  useEffect(() => {
    if (!topologyAssetId || allOrgsMode) {
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
        const raw = data.data ?? data.asset ?? data;
        // Run the same API→view mapping the asset list uses (ipAddress→ip,
        // openPorts normalization, etc.) so the modal renders identically whether
        // it was opened from the list or a topology node click (#1728).
        if (!cancelled) setTopologyAsset(toDetail(mapAsset(raw)));
      })
      .catch(() => {
        if (!cancelled) setTopologyAsset(null);
      })
      .finally(() => {
        if (!cancelled) setTopologyAssetLoading(false);
      });
    return () => { cancelled = true; };
  }, [topologyAssetId, allOrgsMode]);

  const tabLabels: Record<DiscoveryTab, string> = {
    profiles: t('discoveryPage.tabs.profiles'),
    jobs: t('discoveryPage.tabs.jobs'),
    assets: t('discoveryPage.tabs.assets'),
    topology: t('discoveryPage.tabs.topology'),
    changes: t('discoveryPage.tabs.changes')
  };
  const tabButtons = DISCOVERY_TABS.map((id) => ({ id, label: tabLabels[id] }));

  const fetchProfiles = useCallback(async () => {
    // No concrete org → don't fire the unscoped request (it would 400). This
    // covers two null-org cases: explicit All-Orgs scope (the page shows the
    // prompt; clear to an empty list) and the transient pre-hydration null
    // before the first org is auto-selected (keep the spinner up so the
    // profiles tab doesn't flash "no profiles"). The effect re-runs once
    // `currentOrgId` resolves.
    if (currentOrgId === null) {
      setProfilesError(undefined);
      if (allOrgsMode) {
        setProfiles([]);
        setProfilesLoading(false);
      } else {
        setProfilesLoading(true);
      }
      return;
    }
    try {
      setProfilesLoading(true);
      setProfilesError(undefined);
      const response = await fetchWithAuth('/discovery/profiles');
      if (!response.ok) {
        throw new Error(t('discoveryPage.errors.fetchProfiles'));
      }
      const data = await response.json();
      setProfiles(data.data ?? data.profiles ?? data ?? []);
    } catch (err) {
      setProfilesError(err instanceof Error ? err.message : t('discoveryPage.errors.generic'));
    } finally {
      setProfilesLoading(false);
    }
  }, [currentOrgId, allOrgsMode, t]);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  const displayProfiles = useMemo(() => profiles.map(profile => mapProfileToDisplay(profile, t)), [profiles, t]);

  const profileSubnets = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const p of profiles) {
      if (p.subnets?.length) map[p.id] = p.subnets;
    }
    return map;
  }, [profiles]);

  // Sites are fetched lazily now that the org switcher no longer preloads
  // them; the profile form and changes-panel site filter need the list.
  useEffect(() => {
    if (currentOrgId && sites.length === 0) void fetchSites();
  }, [currentOrgId, sites.length, fetchSites]);

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
      siteId: editingProfile.siteId ?? '',
      subnets: editingProfile.subnets ?? [],
      methods: editingProfile.methods ?? [],
      schedule: scheduleToForm(editingProfile.schedule),
      snmp,
      alertSettings: editingProfile.alertSettings ?? defaultAlertSettings
    };
  }, [editingProfile]);

  const handleSubmitProfile = async (values: DiscoveryProfileFormValues) => {
    setSavingProfile(true);
    setProfileFormError(undefined);

    if (!values.siteId) {
      setProfileFormError(t('discoveryPage.errors.selectSite'));
      setSavingProfile(false);
      return;
    }

    if (values.snmp.version === 'v3') {
      if (!values.snmp.username?.trim()) {
        setProfileFormError(t('discoveryPage.errors.snmpUsername'));
        setSavingProfile(false);
        return;
      }
      if (!values.snmp.authPassphrase?.trim()) {
        setProfileFormError(t('discoveryPage.errors.snmpAuthPassphrase'));
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
        throw new Error(data?.error ?? t('discoveryPage.errors.saveProfile'));
      }

      await fetchProfiles();
      setEditingProfile(null);
      setIsProfileModalOpen(false);
      setProfileFormError(undefined);
    } catch (err) {
      setProfileFormError(err instanceof Error ? err.message : t('discoveryPage.errors.generic'));
    } finally {
      setSavingProfile(false);
    }
  };

  const handleDeleteProfile = async (profile: DiscoveryProfile) => {
    if (!confirm(t('discoveryPage.confirmDeleteProfile', { name: profile.name }))) {
      return;
    }

    setProfilesError(undefined);

    try {
      const response = await fetchWithAuth(`/discovery/profiles/${profile.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error(t('discoveryPage.errors.deleteProfile'));
      }

      await fetchProfiles();
    } catch (err) {
      setProfilesError(err instanceof Error ? err.message : t('discoveryPage.errors.generic'));
    }
  };

  const handleRunProfile = async (profile: DiscoveryProfile) => {
    setProfilesError(undefined);
    setRunningProfileId(profile.id);

    try {
      await runAction({
        request: () => fetchWithAuth('/discovery/scan', {
          method: 'POST',
          body: JSON.stringify({ profileId: profile.id })
        }),
        errorFallback: t('discoveryPage.errors.runProfile', { name: profile.name }),
        successMessage: t('discoveryPage.toasts.scanQueued', { name: profile.name }),
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });

      // Switch to jobs tab filtered to this profile so user can see the queued scan
      setJobsProfileFilter(profile.id);
      navigateToTab('jobs');
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 401) return;
        setProfilesError(err.message);
      } else {
        setProfilesError(err instanceof Error ? err.message : t('discoveryPage.errors.generic'));
      }
    } finally {
      setRunningProfileId(null);
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
            setProfilesError(t('discoveryPage.errors.profileDeletedRefresh'));
            return;
          }
          setEditingProfile(match);
          setProfilesError(t('discoveryPage.errors.profileDetailsUnavailable'));
          setIsProfileModalOpen(true);
          return;
        }
        const errData = await response.json().catch(() => null);
        throw new Error(errData?.error ?? t('discoveryPage.errors.loadProfileDetailsHttp', { status: response.status }));
      }
      const data = await response.json();
      const fullProfile: ApiDiscoveryProfile = data.data ?? data.profile ?? data;
      setEditingProfile(fullProfile);
      setIsProfileModalOpen(true);
    } catch (err) {
      setProfilesError(err instanceof Error ? err.message : t('discoveryPage.errors.loadProfileDetails'));
    }
  };

  const navigateToTab = useCallback((tab: DiscoveryTab) => {
    if (typeof window !== 'undefined') window.location.hash = tab;
    setActiveTab(tab);
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
          <h1 className="text-xl font-semibold tracking-tight">{t('discoveryPage.title')}</h1>
          <p className="text-muted-foreground">
            {t('discoveryPage.description')}
          </p>
        </div>
        {activeTab === 'profiles' && !allOrgsMode && (
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
            {t('discoveryPage.actions.newProfile')}
          </button>
        )}
      </div>

      {scope.status === 'error' ? (
        <OrgLoadFailedState error={scope.error} />
      ) : scope.status === 'loading' ? null : (allOrgsMode || scope.status === 'empty') ? (
        <OrgRequiredState description={t('discoveryPage.allOrgs.description')} />
      ) : (
        <>
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
          runningProfileId={runningProfileId}
          onViewJobs={handleNavigateToJobs}
        />
      )}

      {activeTab === 'jobs' && (
        <DiscoveryJobList
          profileFilter={jobsProfileFilter}
          profileSubnets={profileSubnets}
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
              loading={topologyAssetLoading}
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
          siteOptions={siteOptions}
        />
      )}
        </>
      )}

      {isProfileModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-5xl rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">
                  {editingProfile ? t('discoveryPage.modal.editTitle') : t('discoveryPage.modal.newTitle')}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('discoveryPage.modal.description')}
                </p>
              </div>
              <button
                type="button"
                onClick={handleCloseProfileModal}
                className="flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:text-foreground"
                disabled={savingProfile}
                aria-label={t('discoveryPage.modal.closeAria')}
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
                submitLabel={editingProfile
                  ? (savingProfile ? t('discoveryPage.modal.updating') : t('discoveryPage.modal.updateProfile'))
                  : (savingProfile ? t('discoveryPage.modal.creating') : t('discoveryPage.modal.createProfile'))}
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
