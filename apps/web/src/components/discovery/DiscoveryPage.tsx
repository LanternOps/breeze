import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import DiscoveryProfileList, { type DiscoveryProfile } from './DiscoveryProfileList';
import DiscoveryProfileForm, { type DiscoveryProfileFormValues } from './DiscoveryProfileForm';
import DiscoveryJobList, { type DiscoveryJob } from './DiscoveryJobList';
import DiscoveredAssetList, { type DiscoveredAsset } from './DiscoveredAssetList';
import AssetDetailModal, { type AssetDetail } from './AssetDetailModal';
import NetworkTopologyMap, { type TopologyLink, type TopologyNode } from './NetworkTopologyMap';

type DiscoveryTab = 'profiles' | 'jobs' | 'assets' | 'topology';

const initialProfiles: DiscoveryProfile[] = [
  {
    id: 'profile-1',
    name: 'Headquarters Scan',
    subnets: ['10.0.0.0/24', '10.0.1.0/24'],
    methods: ['icmp', 'snmp', 'arp'],
    schedule: 'Daily at 02:00 UTC',
    status: 'active',
    lastRun: '2h ago',
    nextRun: 'Tonight 02:00'
  },
  {
    id: 'profile-2',
    name: 'Remote Office',
    subnets: ['172.16.10.0/24'],
    methods: ['icmp', 'tcp'],
    schedule: 'Weekly on Monday 03:00 UTC',
    status: 'paused',
    lastRun: '6d ago'
  },
  {
    id: 'profile-3',
    name: 'Datacenter Sweep',
    subnets: ['192.168.50.0/24'],
    methods: ['icmp', 'snmp', 'tcp'],
    schedule: 'Monthly on 1st 01:00 UTC',
    status: 'draft'
  }
];

const initialJobs: DiscoveryJob[] = [
  {
    id: 'job-1',
    profileName: 'Headquarters Scan',
    status: 'running',
    progress: 62,
    hostsDiscovered: 120,
    hostsTargeted: 190,
    scheduledAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
  },
  {
    id: 'job-2',
    profileName: 'Remote Office',
    status: 'completed',
    progress: 100,
    hostsDiscovered: 38,
    hostsTargeted: 40,
    scheduledAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    startedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + 10 * 60 * 1000).toISOString(),
    finishedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + 35 * 60 * 1000).toISOString()
  },
  {
    id: 'job-3',
    profileName: 'Datacenter Sweep',
    status: 'scheduled',
    progress: 0,
    hostsDiscovered: 0,
    hostsTargeted: 150,
    scheduledAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()
  },
  {
    id: 'job-4',
    profileName: 'Headquarters Scan',
    status: 'failed',
    progress: 40,
    hostsDiscovered: 72,
    hostsTargeted: 190,
    scheduledAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    startedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 + 12 * 60 * 1000).toISOString(),
    finishedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 + 22 * 60 * 1000).toISOString()
  }
];

const initialAssets: AssetDetail[] = [
  {
    id: 'asset-1',
    ip: '10.0.0.15',
    mac: '00:1B:44:11:3A:B7',
    hostname: 'core-switch-01',
    type: 'network',
    status: 'linked',
    manufacturer: 'Cisco',
    lastSeen: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    openPorts: [22, 161, 443],
    osFingerprint: 'Cisco IOS 15.x',
    snmpData: { sysName: 'core-switch-01', location: 'HQ MDF', uptime: '36 days' },
    linkedDeviceId: 'device-1'
  },
  {
    id: 'asset-2',
    ip: '10.0.0.45',
    mac: 'A4:5E:60:91:22:19',
    hostname: 'print-ops-01',
    type: 'printer',
    status: 'new',
    manufacturer: 'HP',
    lastSeen: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    openPorts: [80, 515, 9100],
    osFingerprint: 'Embedded JetDirect',
    snmpData: { model: 'LaserJet Pro', serial: 'VND12345' }
  },
  {
    id: 'asset-3',
    ip: '10.0.1.88',
    mac: 'F0:9F:C2:1A:7B:8C',
    hostname: 'ws-dev-88',
    type: 'workstation',
    status: 'new',
    manufacturer: 'Dell',
    lastSeen: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    openPorts: [135, 445, 3389],
    osFingerprint: 'Windows 11 Pro',
    snmpData: { owner: 'Engineering', vlan: 'Corp-Users' }
  },
  {
    id: 'asset-4',
    ip: '172.16.10.12',
    mac: 'D8:3A:DD:44:2C:11',
    hostname: 'backup-appliance',
    type: 'server',
    status: 'ignored',
    manufacturer: 'Synology',
    lastSeen: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    openPorts: [22, 5000],
    osFingerprint: 'DSM 7.x',
    snmpData: {}
  }
];

const deviceOptions = [
  { id: 'device-1', name: 'Core Switch - HQ' },
  { id: 'device-2', name: 'Printer Ops 01' },
  { id: 'device-3', name: 'Workstation Dev 88' }
];

const topologyNodes: TopologyNode[] = [
  { id: 'node-1', label: 'Edge Router', type: 'router', status: 'online' },
  { id: 'node-2', label: 'Core Switch', type: 'switch', status: 'online' },
  { id: 'node-3', label: 'File Server', type: 'server', status: 'warning' },
  { id: 'node-4', label: 'Printer', type: 'printer', status: 'online' },
  { id: 'node-5', label: 'Dev WS', type: 'workstation', status: 'online' },
  { id: 'node-6', label: 'Legacy AP', type: 'unknown', status: 'offline' }
];

const topologyLinks: TopologyLink[] = [
  { source: 'node-1', target: 'node-2', type: 'wired' },
  { source: 'node-2', target: 'node-3', type: 'wired' },
  { source: 'node-2', target: 'node-4', type: 'wired' },
  { source: 'node-2', target: 'node-5', type: 'wired' },
  { source: 'node-2', target: 'node-6', type: 'wireless' }
];

export default function DiscoveryPage() {
  const [activeTab, setActiveTab] = useState<DiscoveryTab>('profiles');
  const [profiles, setProfiles] = useState<DiscoveryProfile[]>(initialProfiles);
  const [assets, setAssets] = useState<AssetDetail[]>(initialAssets);
  const [selectedAsset, setSelectedAsset] = useState<AssetDetail | null>(null);
  const [editingProfile, setEditingProfile] = useState<DiscoveryProfile | null>(null);

  const tabButtons: { id: DiscoveryTab; label: string }[] = [
    { id: 'profiles', label: 'Profiles' },
    { id: 'jobs', label: 'Jobs' },
    { id: 'assets', label: 'Assets' },
    { id: 'topology', label: 'Topology' }
  ];

  const formInitialValues = useMemo<DiscoveryProfileFormValues | undefined>(() => {
    if (!editingProfile) return undefined;
    return {
      name: editingProfile.name,
      subnets: editingProfile.subnets,
      methods: editingProfile.methods,
      schedule: {
        cadence: 'daily',
        time: '02:00',
        timezone: 'UTC'
      },
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

  const handleSubmitProfile = (values: DiscoveryProfileFormValues) => {
    if (editingProfile) {
      setProfiles(prev =>
        prev.map(profile =>
          profile.id === editingProfile.id
            ? {
                ...profile,
                name: values.name,
                subnets: values.subnets,
                methods: values.methods,
                schedule: `${values.schedule.cadence} at ${values.schedule.time} ${values.schedule.timezone}`
              }
            : profile
        )
      );
      setEditingProfile(null);
      return;
    }

    setProfiles(prev => [
      {
        id: `profile-${Date.now()}`,
        name: values.name,
        subnets: values.subnets,
        methods: values.methods,
        schedule: `${values.schedule.cadence} at ${values.schedule.time} ${values.schedule.timezone}`,
        status: 'draft'
      },
      ...prev
    ]);
  };

  const handleLinkAsset = (assetId: string, deviceId: string | undefined) => {
    setAssets(prev =>
      prev.map(asset =>
        asset.id === assetId
          ? {
              ...asset,
              linkedDeviceId: deviceId,
              status: deviceId ? 'linked' : asset.status
            }
          : asset
      )
    );
  };

  const assetListData: DiscoveredAsset[] = assets.map(({ openPorts, osFingerprint, snmpData, linkedDeviceId, ...rest }) => rest);

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
          onClick={() => setActiveTab('profiles')}
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
            profiles={profiles}
            onEdit={profile => setEditingProfile(profile)}
            onDelete={profile => setProfiles(prev => prev.filter(item => item.id !== profile.id))}
            onRun={profile => console.log('Run profile', profile.name)}
          />
          <DiscoveryProfileForm
            initialValues={formInitialValues}
            onSubmit={handleSubmitProfile}
            onCancel={() => setEditingProfile(null)}
            submitLabel={editingProfile ? 'Update Profile' : 'Create Profile'}
          />
        </div>
      )}

      {activeTab === 'jobs' && <DiscoveryJobList jobs={initialJobs} />}

      {activeTab === 'assets' && (
        <>
          <DiscoveredAssetList
            assets={assetListData}
            onLink={asset => setSelectedAsset(assets.find(item => item.id === asset.id) ?? null)}
            onIgnore={asset =>
              setAssets(prev =>
                prev.map(item =>
                  item.id === asset.id
                    ? {
                        ...item,
                        status: 'ignored'
                      }
                    : item
                )
              )
            }
            onSelect={asset => setSelectedAsset(assets.find(item => item.id === asset.id) ?? null)}
          />
          <AssetDetailModal
            open={selectedAsset !== null}
            asset={selectedAsset ?? undefined}
            devices={deviceOptions}
            onClose={() => setSelectedAsset(null)}
            onLink={handleLinkAsset}
          />
        </>
      )}

      {activeTab === 'topology' && <NetworkTopologyMap nodes={topologyNodes} links={topologyLinks} />}
    </div>
  );
}
