import { useCallback, useEffect, useState } from 'react';
import { Monitor, Cpu, HardDrive, MemoryStick, Shield, Tag, Info } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type DeviceInfoTabProps = {
  deviceId: string;
};

type DeviceInfo = {
  hostname?: string | null;
  displayName?: string | null;
  osType?: string | null;
  osVersion?: string | null;
  osBuild?: string | null;
  architecture?: string | null;
  agentVersion?: string | null;
  status?: string | null;
  lastSeenAt?: string | null;
  enrolledAt?: string | null;
  tags?: string[];
  customFields?: Record<string, string>;
  hardware?: {
    serialNumber?: string | null;
    manufacturer?: string | null;
    model?: string | null;
    biosVersion?: string | null;
    gpuModel?: string | null;
    cpuModel?: string | null;
    cpuCores?: number | null;
    cpuThreads?: number | null;
    ramTotalMb?: number | null;
    diskTotalGb?: number | null;
  } | null;
};

function formatRam(valueMb: number | null | undefined): string {
  if (valueMb === null || valueMb === undefined) return '—';
  const gb = valueMb / 1024;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${valueMb} MB`;
}

function formatDisk(valueGb: number | null | undefined): string {
  if (valueGb === null || valueGb === undefined) return '—';
  if (valueGb >= 1024) return `${(valueGb / 1024).toFixed(1)} TB`;
  return `${valueGb.toFixed(1)} GB`;
}

function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return '—';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-2">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium text-right">{value || '—'}</dd>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        {icon}
        <h3 className="font-semibold">{title}</h3>
      </div>
      <dl className="divide-y">{children}</dl>
    </div>
  );
}

const statusColors: Record<string, string> = {
  online: 'bg-green-500/20 text-green-700 border-green-500/40',
  offline: 'bg-red-500/20 text-red-700 border-red-500/40',
  maintenance: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
};

export default function DeviceInfoTab({ deviceId }: DeviceInfoTabProps) {
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchInfo = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}`);
      if (!response.ok) throw new Error('Failed to fetch device details');
      const data = await response.json();
      setInfo(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch device details');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchInfo();
  }, [fetchInfo]);

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading device details...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchInfo}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  const hw = info?.hardware;
  const status = info?.status ?? 'offline';
  const tags = info?.tags ?? [];

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Section title="System" icon={<Monitor className="h-4 w-4 text-muted-foreground" />}>
        <InfoRow label="Hostname" value={info?.hostname ?? '—'} />
        <InfoRow label="Display Name" value={info?.displayName ?? '—'} />
        <InfoRow label="Serial Number" value={hw?.serialNumber ?? '—'} />
        <InfoRow label="Manufacturer" value={hw?.manufacturer ?? '—'} />
        <InfoRow label="Model" value={hw?.model ?? '—'} />
      </Section>

      <Section title="Operating System" icon={<Info className="h-4 w-4 text-muted-foreground" />}>
        <InfoRow label="OS Type" value={info?.osType ?? '—'} />
        <InfoRow label="OS Version" value={info?.osVersion ?? '—'} />
        <InfoRow label="OS Build" value={info?.osBuild ?? '—'} />
        <InfoRow label="Architecture" value={info?.architecture ?? '—'} />
      </Section>

      <Section title="Hardware Summary" icon={<Cpu className="h-4 w-4 text-muted-foreground" />}>
        <InfoRow label="CPU Model" value={hw?.cpuModel ?? '—'} />
        <InfoRow label="Cores / Threads" value={
          hw?.cpuCores
            ? `${hw.cpuCores} cores${hw.cpuThreads ? ` / ${hw.cpuThreads} threads` : ''}`
            : '—'
        } />
        <InfoRow label="RAM Total" value={formatRam(hw?.ramTotalMb)} />
        <InfoRow label="Disk Total" value={formatDisk(hw?.diskTotalGb)} />
        <InfoRow label="GPU" value={hw?.gpuModel ?? '—'} />
        <InfoRow label="BIOS Version" value={hw?.biosVersion ?? '—'} />
      </Section>

      <div className="space-y-6">
        <Section title="Agent" icon={<Shield className="h-4 w-4 text-muted-foreground" />}>
          <InfoRow label="Agent Version" value={info?.agentVersion ?? '—'} />
          <div className="flex justify-between py-2">
            <dt className="text-sm text-muted-foreground">Status</dt>
            <dd>
              <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusColors[status] ?? 'bg-muted/40 text-muted-foreground border-muted'}`}>
                {status.charAt(0).toUpperCase() + status.slice(1)}
              </span>
            </dd>
          </div>
          <InfoRow label="Last Seen" value={formatDate(info?.lastSeenAt)} />
          <InfoRow label="Enrolled" value={formatDate(info?.enrolledAt)} />
        </Section>

        {tags.length > 0 && (
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-4">
              <Tag className="h-4 w-4 text-muted-foreground" />
              <h3 className="font-semibold">Tags</h3>
            </div>
            <div className="flex flex-wrap gap-2">
              {tags.map(tag => (
                <span
                  key={tag}
                  className="inline-flex items-center rounded-full border bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
