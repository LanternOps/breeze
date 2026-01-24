import { useCallback, useMemo, useState, useEffect } from 'react';
import { Plus } from 'lucide-react';
import DiscoveryProfileList, { type DiscoveryProfile, type DiscoveryProfileStatus } from './DiscoveryProfileList';
import DiscoveryProfileForm, { type DiscoveryProfileFormValues, type DiscoverySchedule } from './DiscoveryProfileForm';
import DiscoveryJobList from './DiscoveryJobList';
import DiscoveredAssetList from './DiscoveredAssetList';
import NetworkTopologyMap from './NetworkTopologyMap';
import { fetchWithAuth } from '../../stores/auth';

type DiscoveryTab = 'profiles' | 'jobs' | 'assets' | 'topology';

type ApiDiscoverySchedule = {
  type: 'manual' | 'cron' | 'interval';
  cron?: string;
  intervalMinutes?: number;
};

type ApiDiscoveryProfile = {
  id: string;
  name: string;
  subnets: string[];
  methods: string[];
  schedule?: ApiDiscoverySchedule;
  createdAt?: string;
  updatedAt?: string;
};

const fallbackSchedule: DiscoverySchedule = {
  cadence: 'daily',
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
        dayOfWeek: parsed.cadence === 'weekly' ? parsed.dayOfWeek : fallbackSchedule.dayOfWeek,
        dayOfMonth: parsed.cadence === 'monthly' ? parsed.dayOfMonth : fallbackSchedule.dayOfMonth
      };
    }
  }

  if (schedule.type === 'interval' && schedule.intervalMinutes) {
    return { ...fallbackSchedule, cadence: 'daily', time: '00:00' };
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
  const [hour, minute] = schedule.time.split(':');
  const safeHour = (hour ?? '00').padStart(2, '0');
  const safeMinute = (minute ?? '00').padStart(2, '0');

  let cron = `${safeMinute} ${safeHour} * * *`;
  if (schedule.cadence === 'weekly') {
    const dayIndex = dayLabels.findIndex(day => day === schedule.dayOfWeek);
    cron = `${safeMinute} ${safeHour} * * ${dayIndex >= 0 ? dayIndex : 1}`;
  }
  if (schedule.cadence === 'monthly') {
    cron = `${safeMinute} ${safeHour} ${schedule.dayOfMonth ?? '1'} * *`;
  }

  return { type: 'cron', cron };
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

export default function DiscoveryPage() {
  const [activeTab, setActiveTab] = useState<DiscoveryTab>('profiles');
  const [profiles, setProfiles] = useState<ApiDiscoveryProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [profilesError, setProfilesError] = useState<string>();
  const [savingProfile, setSavingProfile] = useState(false);
  const [editingProfile, setEditingProfile] = useState<ApiDiscoveryProfile | null>(null);

  const tabButtons: { id: DiscoveryTab; label: string }[] = [
    { id: 'profiles', label: 'Profiles' },
    { id: 'jobs', label: 'Jobs' },
    { id: 'assets', label: 'Assets' },
    { id: 'topology', label: 'Topology' }
  ];

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

  const formInitialValues = useMemo<DiscoveryProfileFormValues | undefined>(() => {
    if (!editingProfile) return undefined;
    return {
      name: editingProfile.name,
      subnets: editingProfile.subnets ?? [],
      methods: editingProfile.methods ?? [],
      schedule: scheduleToForm(editingProfile.schedule),
      snmp: {
        version: 'v2c',
        community: 'public',
        port: 161,
        timeout: 2000,
        retries: 1,
        username: '',
        authProtocol: 'sha',
        authPassphrase: '',
        privacyProtocol: 'aes',
        privacyPassphrase: ''
      }
    };
  }, [editingProfile]);

  const handleSubmitProfile = async (values: DiscoveryProfileFormValues) => {
    setSavingProfile(true);
    setProfilesError(undefined);

    try {
      const payload = {
        name: values.name,
        subnets: values.subnets,
        methods: values.methods,
        schedule: formScheduleToApi(values.schedule)
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
    } catch (err) {
      setProfilesError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSavingProfile(false);
    }
  };

  const handleDeleteProfile = async (profile: DiscoveryProfile) => {
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
        throw new Error('Failed to run discovery profile');
      }
    } catch (err) {
      setProfilesError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const handleEditProfile = (profile: DiscoveryProfile) => {
    const match = profiles.find(item => item.id === profile.id) ?? null;
    setEditingProfile(match);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Network Discovery</h1>
          <p className="text-muted-foreground">
            Configure discovery profiles, monitor scans, and review assets.
          </p>
        </div>
        <button
          type="button"
          className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          onClick={() => {
            setEditingProfile(null);
            setActiveTab('profiles');
          }}
        >
          <Plus className="h-4 w-4" />
          New Profile
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {tabButtons.map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
              activeTab === tab.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'profiles' && (
        <div className="grid gap-6 xl:grid-cols-[2fr,1fr]">
          <DiscoveryProfileList
            profiles={displayProfiles}
            loading={profilesLoading}
            error={profilesError}
            onRetry={fetchProfiles}
            onEdit={handleEditProfile}
            onDelete={handleDeleteProfile}
            onRun={handleRunProfile}
          />
          <DiscoveryProfileForm
            initialValues={formInitialValues}
            onSubmit={handleSubmitProfile}
            onCancel={() => setEditingProfile(null)}
            submitLabel={editingProfile ? (savingProfile ? 'Updating...' : 'Update Profile') : (savingProfile ? 'Creating...' : 'Create Profile')}
          />
        </div>
      )}

      {activeTab === 'jobs' && <DiscoveryJobList />}

      {activeTab === 'assets' && <DiscoveredAssetList />}

      {activeTab === 'topology' && <NetworkTopologyMap />}
    </div>
  );
}
