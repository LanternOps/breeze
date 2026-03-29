import { useEffect, useState } from 'react';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Legend,
  Tooltip
} from 'recharts';
import { Loader2, XCircle } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

interface DeviceStatusData {
  name: string;
  value: number;
  color: string;
}

export default function DeviceStatusChart() {
  const [data, setData] = useState<DeviceStatusData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchDeviceStatus = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const response = await fetchWithAuth('/devices');

        if (!response.ok) {
          throw new Error('Failed to fetch devices');
        }

        const devicesData = await response.json();
        const devices = devicesData.devices ?? devicesData.data ?? (Array.isArray(devicesData) ? devicesData : []);

        // Count devices by status
        const onlineCount = devices.filter((d: { status: string }) => d.status === 'online').length;
        const offlineCount = devices.filter((d: { status: string }) => d.status === 'offline').length;
        const warningCount = devices.filter((d: { status: string }) => d.status === 'warning').length;

        // Read semantic colors from CSS custom properties with fallbacks
        const root = getComputedStyle(document.documentElement);
        const cssColor = (prop: string, fallback: string): string => {
          const v = root.getPropertyValue(prop).trim();
          return v ? `hsl(${v})` : fallback;
        };

        setData([
          { name: 'Online', value: onlineCount, color: cssColor('--success', 'hsl(152, 56%, 37%)') },
          { name: 'Offline', value: offlineCount, color: cssColor('--muted-foreground', 'hsl(220, 10%, 46%)') },
          { name: 'Warning', value: warningCount, color: cssColor('--warning', 'hsl(36, 88%, 50%)') }
        ].filter(item => item.value > 0));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load device status');
      } finally {
        setIsLoading(false);
      }
    };

    fetchDeviceStatus();
  }, []);

  if (isLoading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <h3 className="mb-4 text-sm font-semibold">Device Status</h3>
        <div className="flex h-64 items-center justify-center">
          <div className="skeleton h-40 w-40 rounded-full" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <h3 className="mb-4 text-sm font-semibold">Device Status</h3>
        <div className="flex h-64 items-center justify-center">
          <div className="flex items-center gap-2 text-destructive">
            <XCircle className="h-5 w-5" />
            <span className="text-sm">{error}</span>
          </div>
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <h3 className="mb-4 text-sm font-semibold">Device Status</h3>
        <div className="flex h-64 items-center justify-center">
          <span className="text-sm text-muted-foreground">No devices found</span>
        </div>
      </div>
    );
  }

  return (
    <div className="hover-lift rounded-lg border bg-card p-6 shadow-sm">
      <h3 className="mb-4 text-sm font-semibold">Device Status</h3>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={80}
              paddingAngle={5}
              dataKey="value"
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip wrapperClassName="chart-tooltip" />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
