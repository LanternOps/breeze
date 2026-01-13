import { useMemo, useState } from 'react';
import { FileCog, ShieldCheck, CalendarClock, BarChart3, Plus } from 'lucide-react';
import PatchList, { type Patch } from './PatchList';
import PatchApprovalModal, { type PatchApprovalAction } from './PatchApprovalModal';
import PatchComplianceDashboard, { type DevicePatchNeed, type PatchSeveritySummary } from './PatchComplianceDashboard';
import PatchPolicyList, { type PatchPolicy } from './PatchPolicyList';
import PatchJobList, { type PatchJob } from './PatchJobList';
import DevicePatchStatus from './DevicePatchStatus';

const samplePatches: Patch[] = [
  {
    id: 'patch-001',
    title: 'Windows 11 KB5034123 - March Security Update',
    severity: 'critical',
    source: 'Windows Update',
    os: 'Windows',
    releaseDate: '2024-03-12',
    approvalStatus: 'pending',
    description: 'Fixes multiple privilege escalation vulnerabilities.'
  },
  {
    id: 'patch-002',
    title: 'macOS Sonoma 14.4 Supplemental Update',
    severity: 'important',
    source: 'Apple Software Update',
    os: 'macOS',
    releaseDate: '2024-03-18',
    approvalStatus: 'approved',
    description: 'Stability and security improvements for Safari.'
  },
  {
    id: 'patch-003',
    title: 'Ubuntu 22.04 OpenSSL Patch',
    severity: 'moderate',
    source: 'Ubuntu Repo',
    os: 'Linux',
    releaseDate: '2024-03-08',
    approvalStatus: 'deferred',
    description: 'TLS stability fixes for OpenSSL libraries.'
  },
  {
    id: 'patch-004',
    title: 'Chrome 122.0.6261.112',
    severity: 'low',
    source: 'Google Update',
    os: 'Windows',
    releaseDate: '2024-02-27',
    approvalStatus: 'declined',
    description: 'Minor UI fixes and performance improvements.'
  }
];

const samplePolicies: PatchPolicy[] = [
  {
    id: 'policy-001',
    name: 'Critical OS patches',
    targets: ['All devices'],
    schedule: 'Weekly, Sun 02:00',
    status: 'active',
    updatedAt: '2024-03-10'
  },
  {
    id: 'policy-002',
    name: 'Third-party updates - Sales',
    targets: ['Sales group'],
    schedule: 'Daily, 22:00',
    status: 'paused',
    updatedAt: '2024-02-28'
  },
  {
    id: 'policy-003',
    name: 'Firmware rollout - HQ',
    targets: ['HQ site'],
    schedule: 'Monthly, 1st 01:00',
    status: 'draft',
    updatedAt: '2024-03-01'
  }
];

const sampleJobs: PatchJob[] = [
  {
    id: 'job-1024',
    name: 'March critical rollout',
    status: 'running',
    startedAt: '2024-03-18',
    devicesTotal: 320,
    devicesPatched: 214,
    devicesFailed: 4
  },
  {
    id: 'job-1023',
    name: 'macOS 14.4 supplemental',
    status: 'completed',
    startedAt: '2024-03-12',
    completedAt: '2024-03-13',
    devicesTotal: 92,
    devicesPatched: 92,
    devicesFailed: 0
  },
  {
    id: 'job-1022',
    name: 'Ubuntu OpenSSL patch',
    status: 'failed',
    startedAt: '2024-03-11',
    completedAt: '2024-03-11',
    devicesTotal: 58,
    devicesPatched: 40,
    devicesFailed: 6
  }
];

const criticalSummary: PatchSeveritySummary = {
  total: 48,
  patched: 36,
  pending: 12
};

const importantSummary: PatchSeveritySummary = {
  total: 74,
  patched: 58,
  pending: 16
};

const devicesNeedingPatches: DevicePatchNeed[] = [
  {
    id: 'device-001',
    name: 'FIN-LT-021',
    os: 'Windows 11',
    missingCount: 6,
    criticalCount: 2,
    importantCount: 3,
    lastSeen: '2h ago'
  },
  {
    id: 'device-002',
    name: 'ENG-MB-114',
    os: 'macOS 14.3',
    missingCount: 4,
    criticalCount: 1,
    importantCount: 2,
    lastSeen: '5h ago'
  },
  {
    id: 'device-003',
    name: 'OPS-SRV-04',
    os: 'Ubuntu 22.04',
    missingCount: 9,
    criticalCount: 3,
    importantCount: 4,
    lastSeen: '1d ago'
  }
];

type TabKey = 'patches' | 'policies' | 'jobs' | 'compliance';

export default function PatchesPage() {
  const [activeTab, setActiveTab] = useState<TabKey>('patches');
  const [selectedPatch, setSelectedPatch] = useState<Patch | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const tabs = useMemo(
    () => [
      { id: 'patches' as TabKey, label: 'Patches', icon: <FileCog className="h-4 w-4" /> },
      { id: 'policies' as TabKey, label: 'Policies', icon: <ShieldCheck className="h-4 w-4" /> },
      { id: 'jobs' as TabKey, label: 'Jobs', icon: <CalendarClock className="h-4 w-4" /> },
      { id: 'compliance' as TabKey, label: 'Compliance', icon: <BarChart3 className="h-4 w-4" /> }
    ],
    []
  );

  const handleReview = (patch: Patch) => {
    setSelectedPatch(patch);
    setModalOpen(true);
  };

  const handleApprovalSubmit = async (_patchId: string, _action: PatchApprovalAction, _notes: string) => {
    setModalOpen(false);
    setSelectedPatch(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Patch Management</h1>
          <p className="text-muted-foreground">Track approvals, compliance, and patch deployments.</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
            New Policy
          </button>
        </div>
      </div>

      <div className="border-b">
        <nav className="-mb-px flex gap-4 overflow-x-auto">
          {tabs.map(tab => (
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
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'patches' && (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <PatchList patches={samplePatches} onReview={handleReview} />
          </div>
          <div className="space-y-6">
            <DevicePatchStatus
              deviceName="FIN-LT-021"
              os="Windows 11"
              availableCount={6}
              installedCount={18}
              failedCount={1}
              patches={[
                { id: 'patch-01', title: 'KB5034123 Security Update', severity: 'critical', status: 'available' },
                { id: 'patch-02', title: 'Edge 122.0.2365', severity: 'important', status: 'available' },
                { id: 'patch-03', title: 'Defender Platform Update', severity: 'moderate', status: 'installed' },
                { id: 'patch-04', title: 'Visual C++ Redistributable', severity: 'low', status: 'failed' }
              ]}
            />
          </div>
        </div>
      )}

      {activeTab === 'policies' && (
        <PatchPolicyList policies={samplePolicies} />
      )}

      {activeTab === 'jobs' && (
        <PatchJobList jobs={sampleJobs} />
      )}

      {activeTab === 'compliance' && (
        <PatchComplianceDashboard
          totalDevices={420}
          compliantDevices={318}
          criticalSummary={criticalSummary}
          importantSummary={importantSummary}
          devicesNeedingPatches={devicesNeedingPatches}
        />
      )}

      <PatchApprovalModal
        open={modalOpen}
        patch={selectedPatch}
        onClose={() => {
          setModalOpen(false);
          setSelectedPatch(null);
        }}
        onSubmit={handleApprovalSubmit}
      />
    </div>
  );
}
